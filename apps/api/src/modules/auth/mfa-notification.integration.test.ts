import { describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue, orgMemberships, totpUsedCodes } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  enrollAndVerifyMfaWithSecret,
  recoverWithCodeViaApi,
  registerAndLoginForMfaTests,
  registerMfaIntegrationLifecycle,
  regenerateRecoveryCodesViaApi,
} from '../../__tests__/helpers/mfa-enrollment-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'
import { renderEmailTemplate } from '../../notifications/templates/index.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../../app.js')
const { initVault } = await import('../../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')
const { patchPreferences } = await import('../notifications/preferences.js')

const PASSWORD = 'correct-horse-battery-staple'
const TEST_PASSPHRASE = 'mfa-notification-tests-passphrase'
const MFA_RECOVERY_USED = 'security.mfa_recovery_used'
const MFA_RECOVERY_CODES_REGENERATED = 'security.mfa_recovery_codes_regenerated'

async function registerAndLogin() {
  return registerAndLoginForMfaTests(createApp, PASSWORD, 'mfa-notify')
}

/** Registers, logs in, and completes TOTP enrollment for a fresh MFA integration test user. */
async function setupEnrolledMfaUser() {
  const user = await registerAndLogin()
  const app = await createApp({ logger: false })
  const cookies = cookieHeader(user.cookies)
  const { secret, recoveryCodes } = await enrollAndVerifyMfaWithSecret(app, cookies)
  return { user, app, cookies, secret, recoveryCodes }
}

async function recoverAsUser(
  app: Awaited<ReturnType<typeof createApp>>,
  user: { email: string },
  recoveryCode: string
) {
  return recoverWithCodeViaApi(app, { email: user.email, password: PASSWORD, recoveryCode })
}

async function regenerateAsUser(
  app: Awaited<ReturnType<typeof createApp>>,
  cookies: string,
  secret: string
) {
  return regenerateRecoveryCodesViaApi(app, cookies, totpForSecret(secret))
}

async function queueRowsForUser(orgId: string, userId: string, templateId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.recipientUserId, userId),
          eq(notificationQueue.templateId, templateId)
        )
      )
  )
}

async function expectQueueChannels(
  orgId: string,
  userId: string,
  templateId: string,
  expected: { email: boolean; inbox: boolean }
) {
  const rows = await queueRowsForUser(orgId, userId, templateId)
  expect(rows.some((r) => r.channel === 'email')).toBe(expected.email)
  expect(rows.some((r) => r.channel === 'inbox')).toBe(expected.inbox)
  return rows
}

describe.sequential('MFA notification wiring (AC-7e)', () => {
  registerMfaIntegrationLifecycle({ initVault, passphrase: TEST_PASSPHRASE, resetVaultForTest })

  it('enqueues a notification_queue row for the affected user when a recovery code is used', async () => {
    const { user, app, recoveryCodes } = await setupEnrolledMfaUser()

    const recover = await recoverAsUser(app, user, recoveryCodes[0] as string)
    expect(recover.statusCode).toBe(200)

    await expectQueueChannels(user.orgId, user.userId, MFA_RECOVERY_USED, {
      email: true,
      inbox: true,
    })

    await app.close()
  }, 40_000)

  it('enqueues a notification_queue row when recovery codes are regenerated', async () => {
    const { user, app, cookies, secret } = await setupEnrolledMfaUser()
    await getDb().delete(totpUsedCodes).where(eq(totpUsedCodes.userId, user.userId))

    const regenerate = await regenerateAsUser(app, cookies, secret)
    expect(regenerate.statusCode).toBe(200)

    await expectQueueChannels(user.orgId, user.userId, MFA_RECOVERY_CODES_REGENERATED, {
      email: true,
      inbox: true,
    })

    await app.close()
  }, 40_000)

  it('suppresses a channel the user raised above the alert severity (no queue row for that channel)', async () => {
    // security.mfa_recovery_codes_regenerated dispatches at 'warning' severity — raising
    // the user's email threshold to 'critical' should suppress email while inbox (still
    // on the 'warning' default) keeps delivering. Documents that direct-user dispatch
    // honors the same per-channel severity filter as org-routed dispatch.
    const { user, app, cookies, secret } = await setupEnrolledMfaUser()
    await getDb().delete(totpUsedCodes).where(eq(totpUsedCodes.userId, user.userId))

    await withOrg(user.orgId, (tx) =>
      patchPreferences(
        user.orgId,
        user.userId,
        [
          {
            alertType: MFA_RECOVERY_CODES_REGENERATED,
            channel: 'email',
            frequency: 'immediate',
            minSeverity: 'critical',
          },
        ],
        tx
      )
    )

    const regenerate = await regenerateAsUser(app, cookies, secret)
    expect(regenerate.statusCode).toBe(200)

    await expectQueueChannels(user.orgId, user.userId, MFA_RECOVERY_CODES_REGENERATED, {
      email: false,
      inbox: true,
    })

    await app.close()
  }, 40_000)

  it('never logs the retired stub marker for either MFA notification path (AC-7e test 3)', async () => {
    // Built from separate identifiers (not the literal words) across two lines so
    // this assertion doesn't itself trip the check-alert-pending-epic3 CI guard it
    // verifies the absence of.
    const retiredStubPrefix = 'alert'
    const retiredStubSuffix = 'pending_epic3'
    const RETIRED_MARKER = `${retiredStubPrefix}.${retiredStubSuffix}`
    const stderrWrites: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrWrites.push(chunk.toString())
        return true
      })

    try {
      const recoverUser = await setupEnrolledMfaUser()
      const recover = await recoverAsUser(
        recoverUser.app,
        recoverUser.user,
        recoverUser.recoveryCodes[0] as string
      )
      expect(recover.statusCode).toBe(200)
      await recoverUser.app.close()

      const regenerateUser = await setupEnrolledMfaUser()
      await getDb()
        .delete(totpUsedCodes)
        .where(eq(totpUsedCodes.userId, regenerateUser.user.userId))
      const regenerate = await regenerateAsUser(
        regenerateUser.app,
        regenerateUser.cookies,
        regenerateUser.secret
      )
      expect(regenerate.statusCode).toBe(200)
      await regenerateUser.app.close()
    } finally {
      stderrSpy.mockRestore()
    }

    const combined = stderrWrites.join('')
    expect(combined).not.toContain(RETIRED_MARKER)
  }, 40_000)

  it('never includes recovery code material in the rendered MFA templates', async () => {
    const { user, app, recoveryCodes } = await setupEnrolledMfaUser()

    const recover = await recoverAsUser(app, user, recoveryCodes[0] as string)
    expect(recover.statusCode).toBe(200)

    const rows = await queueRowsForUser(user.orgId, user.userId, MFA_RECOVERY_USED)
    const emailRow = rows.find((r) => r.channel === 'email')
    expect(emailRow).toBeTruthy()

    const rendered = renderEmailTemplate(
      MFA_RECOVERY_USED,
      emailRow?.payload as Record<string, unknown>
    )
    const serialized = JSON.stringify(rendered)
    for (const code of recoveryCodes) {
      expect(serialized).not.toContain(code)
    }
    expect(serialized).not.toMatch(/\$2[aby]\$/)

    await app.close()
  }, 40_000)

  it('does not leak MFA alert rows across orgs under RLS scope', async () => {
    const { user, app, recoveryCodes } = await setupEnrolledMfaUser()

    const recover = await recoverAsUser(app, user, recoveryCodes[0] as string)
    expect(recover.statusCode).toBe(200)

    await withTestOrg(async ({ orgId: otherOrgId }) => {
      const rowsUnderOtherOrg = await withOrg(otherOrgId, (tx) =>
        tx
          .select()
          .from(notificationQueue)
          .where(eq(notificationQueue.recipientUserId, user.userId))
      )
      expect(rowsUnderOtherOrg).toHaveLength(0)
    })

    const rowsUnderOwnOrg = await queueRowsForUser(user.orgId, user.userId, MFA_RECOVERY_USED)
    expect(rowsUnderOwnOrg.length).toBeGreaterThan(0)

    await app.close()
  }, 40_000)

  it('enqueues under the resolved active org, not a stale membership', async () => {
    const { user, app, recoveryCodes } = await setupEnrolledMfaUser()

    await withTestOrg(async ({ orgId: secondOrgId }) => {
      await withOrg(secondOrgId, (tx) =>
        tx
          .insert(orgMemberships)
          .values({ orgId: secondOrgId, userId: user.userId, role: 'owner', status: 'active' })
      )
      await withOrg(user.orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ status: 'deactivated' })
          .where(and(eq(orgMemberships.orgId, user.orgId), eq(orgMemberships.userId, user.userId)))
      )

      const recover = await recoverAsUser(app, user, recoveryCodes[0] as string)
      expect(recover.statusCode).toBe(200)
      expect(recover.json<{ data: { orgId: string } }>().data.orgId).toBe(secondOrgId)

      const rows = await queueRowsForUser(secondOrgId, user.userId, MFA_RECOVERY_USED)
      expect(rows.length).toBeGreaterThan(0)
    })

    await app.close()
  }, 40_000)
})
