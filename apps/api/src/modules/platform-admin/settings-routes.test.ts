import { randomUUID } from 'node:crypto'
import { describe, expect, it, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { systemSettings } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import {
  setEmailTransportForTesting,
  resetEmailTransportForTesting,
} from '../../workers/notification-email.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'platform-admin-settings-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const SETTINGS_URL = '/api/v1/admin/settings'
const NEW_SMTP_HOST = 'smtp.new.com'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

async function getSettings(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'GET',
    url: SETTINGS_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function putSettings(app: TestApp, cookies: CookieJar, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: SETTINGS_URL,
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}

describe.sequential('Story 9.2 platform-admin settings routes', () => {
  suite.registerLifecycle()

  afterEach(async () => {
    resetEmailTransportForTesting()
    await getDb().delete(systemSettings)
  })

  it('AC-1: 401 with no auth header', async () => {
    const res = await suite.app.inject({ method: 'GET', url: SETTINGS_URL })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'access_token_missing' })
  })

  it('AC-1: 403 platform_operator_required for a non-operator org owner', async () => {
    const { enrollUserWithMfa } = await import('../../__tests__/helpers/mfa-enroll-test-helpers.js')
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'settings-nonop-owner',
      orgNamePrefix: 'Settings NonOp Owner',
      password: PASSWORD,
    })

    const res = await getSettings(suite.app, owner.cookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
  })

  it('AC-1: 403 mfa_required for a platform operator who never enrolled MFA', async () => {
    const { getDb: freshGetDb } = await import('@project-vault/db')
    const { users } = await import('@project-vault/db/schema')
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `settings-no-mfa-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Settings No MFA ${randomUUID()}`,
    })
    const { withOrg } = await import('@project-vault/db')
    const { orgMemberships } = await import('@project-vault/db/schema')
    await freshGetDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx
        .update(users)
        .set({ isPlatformOperator: true })
        .where(eq(users.id, registered.userId))
    })
    // Story 1.7's MFA-enforcement grace period gives a freshly-registered owner a window before
    // MFA becomes mandatory — expire it directly so this test exercises the enforced case.
    await withOrg(registered.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, registered.userId))
    )
    const res = await getSettings(suite.app, registered.cookies)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('AC-2/AC-4: GET returns env-var-sourced defaults when no system_settings row exists', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-get-default',
      orgNamePrefix: 'Settings Get Default',
      password: PASSWORD,
    })
    const res = await getSettings(suite.app, operator.cookies)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      smtp: { host: string | null; configured: boolean }
      instancePolicy: { maxOrgs: number; maxUsersPerOrg: number }
    }>()
    expect(body.instancePolicy.maxOrgs).toBe(10)
    expect(body.instancePolicy.maxUsersPerOrg).toBe(50)
  })

  it('AC-3: PUT partial update only changes provided fields', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-put-partial',
      orgNamePrefix: 'Settings Put Partial',
      password: PASSWORD,
    })
    const first = await putSettings(suite.app, operator.cookies, {
      instancePolicy: { maxOrgs: 25 },
    })
    expect(first.statusCode).toBe(200)
    expect(
      first.json<{ instancePolicy: { maxOrgs: number; maxUsersPerOrg: number } }>()
    ).toMatchObject({ instancePolicy: { maxOrgs: 25, maxUsersPerOrg: 50 } })

    const second = await putSettings(suite.app, operator.cookies, {
      smtp: { host: NEW_SMTP_HOST, port: 465 },
    })
    expect(second.statusCode).toBe(200)
    const secondBody = second.json<{
      instancePolicy: { maxOrgs: number }
      smtp: { host: string }
    }>()
    // The earlier maxOrgs: 25 must survive an unrelated later PUT (no reset-by-omission).
    expect(secondBody.instancePolicy.maxOrgs).toBe(25)
    expect(secondBody.smtp.host).toBe(NEW_SMTP_HOST)
  })

  it('AC-3/AC-5: SMTP password is write-only, encrypted at rest, and the "[configured]" sentinel is treated as omitted', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-put-password',
      orgNamePrefix: 'Settings Put Password',
      password: PASSWORD,
    })
    const first = await putSettings(suite.app, operator.cookies, {
      smtp: { host: NEW_SMTP_HOST, password: 'new-smtp-secret' },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json<{ smtp: { configured: boolean } }>().smtp.configured).toBe(true)

    const [row] = await getDb().select().from(systemSettings).where(eq(systemSettings.id, 1))
    expect(row?.smtpPassEncrypted).toBeTruthy()
    expect(JSON.stringify(row?.smtpPassEncrypted)).not.toContain('new-smtp-secret')
    const ciphertextBefore = JSON.stringify(row?.smtpPassEncrypted)

    const second = await putSettings(suite.app, operator.cookies, {
      smtp: { host: NEW_SMTP_HOST, password: '[configured]' },
    })
    expect(second.statusCode).toBe(200)
    const [rowAfter] = await getDb().select().from(systemSettings).where(eq(systemSettings.id, 1))
    expect(JSON.stringify(rowAfter?.smtpPassEncrypted)).toBe(ciphertextBefore)
  })

  it('AC-3: validation error on out-of-range smtp.port', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-put-invalid-port',
      orgNamePrefix: 'Settings Put Invalid Port',
      password: PASSWORD,
    })
    const res = await putSettings(suite.app, operator.cookies, { smtp: { port: 99999 } })
    expect(res.statusCode).toBe(422)
  })

  it('AC-3: validation error on maxOrgs < 1', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-put-invalid-maxorgs',
      orgNamePrefix: 'Settings Put Invalid MaxOrgs',
      password: PASSWORD,
    })
    const res = await putSettings(suite.app, operator.cookies, { instancePolicy: { maxOrgs: 0 } })
    expect(res.statusCode).toBe(422)
  })

  it('AC-6: SMTP transport cache is invalidated only when an SMTP field changes', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-put-cache',
      orgNamePrefix: 'Settings Put Cache',
      password: PASSWORD,
    })
    const fakeTransport = { sendMail: async () => ({}) } as unknown as Parameters<
      typeof setEmailTransportForTesting
    >[0]
    setEmailTransportForTesting(fakeTransport)

    // Unrelated update — must NOT drop the cached transport.
    await putSettings(suite.app, operator.cookies, { instancePolicy: { maxOrgs: 30 } })
    const { getEmailTransport } = await import('../../workers/notification-email.js')
    expect(await getEmailTransport()).toBe(fakeTransport)

    // SMTP field update — must drop the cached transport (rebuilt lazily on next access).
    await putSettings(suite.app, operator.cookies, { smtp: { host: 'smtp.rebuilt.com' } })
    expect(await getEmailTransport()).not.toBe(fakeTransport)
  })

  it('AC-22: two concurrent PUTs with non-overlapping field sets both apply — no lost update', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'settings-concurrent',
      orgNamePrefix: 'Settings Concurrent',
      password: PASSWORD,
    })

    const [resA, resB] = await Promise.all([
      putSettings(suite.app, operator.cookies, { instancePolicy: { maxOrgs: 20 } }),
      putSettings(suite.app, operator.cookies, { smtp: { host: 'smtp.concurrent.com' } }),
    ])
    expect(resA.statusCode).toBe(200)
    expect(resB.statusCode).toBe(200)

    const final = await getSettings(suite.app, operator.cookies)
    const body = final.json<{
      instancePolicy: { maxOrgs: number }
      smtp: { host: string }
    }>()
    // Both concurrent writers' fields must be present — neither a blind full-row overwrite by
    // whichever transaction committed last, nor a silently dropped update.
    expect(body.instancePolicy.maxOrgs).toBe(20)
    expect(body.smtp.host).toBe('smtp.concurrent.com')
  })

  // Story 9.4 AC-8: retrofit — PUT /admin/settings also writes a platform_audit_events row.
  describe('Story 9.4 AC-8: platform_audit_events retrofit', () => {
    it('writes a settings.updated row in the same transaction, without leaking the raw password', async () => {
      const { withPlatformOperatorContext } = await import('@project-vault/db')
      const { platformAuditEvents } = await import('@project-vault/db/schema')
      const { eq: eqOp } = await import('drizzle-orm')

      const operator = await registerPlatformOperator(suite.app, {
        emailPrefix: 'settings-platform-audit',
        orgNamePrefix: 'Settings Platform Audit',
        password: PASSWORD,
      })
      const res = await putSettings(suite.app, operator.cookies, {
        smtp: { host: NEW_SMTP_HOST, password: 'top-secret-smtp-pass' },
      })
      expect(res.statusCode).toBe(200)

      const rows = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eqOp(platformAuditEvents.actionType, 'settings.updated'))
      )
      const row = rows.find((r) => r.operatorId === operator.userId)
      expect(row).toBeDefined()
      expect(JSON.stringify(row?.payload)).not.toContain('top-secret-smtp-pass')
      expect((row?.payload as { fieldsChanged?: string[] })?.fieldsChanged).toContain('smtp')
    })

    it('does not write a platform_audit_events row for a no-op empty-body PUT (AC-8 edge case)', async () => {
      const { withPlatformOperatorContext } = await import('@project-vault/db')
      const { platformAuditEvents } = await import('@project-vault/db/schema')
      const { eq: eqOp } = await import('drizzle-orm')

      const operator = await registerPlatformOperator(suite.app, {
        emailPrefix: 'settings-platform-audit-noop',
        orgNamePrefix: 'Settings Platform Audit Noop',
        password: PASSWORD,
      })
      const before = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eqOp(platformAuditEvents.operatorId, operator.userId))
      )

      const res = await putSettings(suite.app, operator.cookies, {})
      expect(res.statusCode).toBe(200)

      const after = await withPlatformOperatorContext((tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eqOp(platformAuditEvents.operatorId, operator.userId))
      )
      expect(after).toHaveLength(before.length)
    })
  })
})
