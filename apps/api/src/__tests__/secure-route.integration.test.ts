import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, securityAlerts } from '@project-vault/db/schema'
import { secureRoute } from '../lib/secure-route.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from './helpers/auth-test-helpers.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault, unsealVault, zeroKeys } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')

const TEST_PASSPHRASE = 'secure-route-tests-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const RLS_ALERTS_URL = '/api/v1/test/rls-alerts'

function uniqueEmail(label: string): string {
  return `secure-route-${label}-${randomUUID()}@example.com`
}

describe.sequential('SecureRoute integration', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('rejects unauthenticated protected routes before the handler runs', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'GET',
      url: '/api/v1/test/secure-route-auth-required',
      handler: async () => ({ data: { reached: true } }),
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/test/secure-route-auth-required' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({
      code: 'access_token_missing',
      message: 'Access token is missing',
    })
    await app.close()
  })

  it('sets current org inside the handler transaction', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'GET',
      url: '/api/v1/test/rls-current-org',
      security: { writeAuditEvent: false },
      handler: async (ctx) => {
        const [row] = await ctx.tx.execute(
          sql`SELECT current_setting('app.current_org_id', true) AS current_org_id`
        )
        return { data: row }
      },
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('current-org'),
      password: PASSWORD,
      orgName: `SecureRoute Current Org ${randomUUID()}`,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/rls-current-org',
      headers: { cookie: cookieHeader(user.cookies) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { current_org_id: user.orgId } })
    await app.close()
  })

  it('applies org isolation through ctx.tx on request handlers', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'GET',
      url: RLS_ALERTS_URL,
      security: { writeAuditEvent: false },
      handler: async (ctx) => {
        const rows = await ctx.tx.select().from(securityAlerts)
        return { data: rows.map((row) => ({ orgId: row.orgId, alertType: row.alertType })) }
      },
    })
    const orgA = await registerAndLoginViaApi(app, {
      email: uniqueEmail('org-a'),
      password: PASSWORD,
      orgName: `SecureRoute Org A ${randomUUID()}`,
    })
    const orgB = await registerAndLoginViaApi(app, {
      email: uniqueEmail('org-b'),
      password: PASSWORD,
      orgName: `SecureRoute Org B ${randomUUID()}`,
    })
    await withOrg(orgA.orgId, (tx) =>
      tx.insert(securityAlerts).values({ orgId: orgA.orgId, alertType: 'a', severity: 'info' })
    )
    await withOrg(orgB.orgId, (tx) =>
      tx.insert(securityAlerts).values({ orgId: orgB.orgId, alertType: 'b', severity: 'info' })
    )

    const resA = await app.inject({
      method: 'GET',
      url: RLS_ALERTS_URL,
      headers: { cookie: cookieHeader(orgA.cookies) },
    })
    const resB = await app.inject({
      method: 'GET',
      url: RLS_ALERTS_URL,
      headers: { cookie: cookieHeader(orgB.cookies) },
    })

    expect(resA.statusCode).toBe(200)
    expect(resA.json()).toMatchObject({ data: [{ orgId: orgA.orgId, alertType: 'a' }] })
    expect(resB.statusCode).toBe(200)
    expect(resB.json()).toMatchObject({ data: [{ orgId: orgB.orgId, alertType: 'b' }] })

    const bareRows = await getDb()
      .select()
      .from(securityAlerts)
      .where(sql`alert_type in ('a', 'b')`)
    expect(bareRows).toHaveLength(0)

    const jobRows = await runOrgScopedJob(orgA.orgId, 'test-secure-route-rls', ({ tx }) =>
      tx
        .select()
        .from(securityAlerts)
        .where(sql`alert_type in ('a', 'b')`)
    )
    expect(jobRows.map((row) => row.orgId)).toEqual([orgA.orgId])
    await app.close()
  })

  it('commits handler writes and audit rows together on success', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'POST',
      url: '/api/v1/test/audit-success',
      security: {
        writeAuditEvent: { eventType: 'test.audit_success', resourceType: 'security_alert' },
      },
      handler: async (ctx) => {
        await ctx.tx.insert(securityAlerts).values({
          orgId: ctx.auth.orgId,
          alertType: 'audit_success_probe',
          severity: 'info',
        })
        return { data: { inserted: true } }
      },
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('audit-success'),
      password: PASSWORD,
      orgName: `SecureRoute Audit Success ${randomUUID()}`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/test/audit-success',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    const rows = await withOrg(user.orgId, (tx) =>
      tx
        .select()
        .from(securityAlerts)
        .where(sql`alert_type = 'audit_success_probe'`)
    )
    const audits = await withOrg(user.orgId, (tx) =>
      tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, 'test.audit_success'))
    )

    expect(res.statusCode).toBe(200)
    expect(rows).toHaveLength(1)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ orgId: user.orgId, resourceType: 'security_alert' })
    await app.close()
  })

  it('rolls back handler writes and audit rows when the handler throws', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'POST',
      url: '/api/v1/test/audit-handler-throws',
      security: {
        writeAuditEvent: { eventType: 'test.audit_handler_throws', resourceType: 'security_alert' },
      },
      handler: async (ctx) => {
        await ctx.tx.insert(securityAlerts).values({
          orgId: ctx.auth.orgId,
          alertType: 'audit_throw_probe',
          severity: 'info',
        })
        throw new Error('forced handler failure')
      },
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('audit-throws'),
      password: PASSWORD,
      orgName: `SecureRoute Audit Throws ${randomUUID()}`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/test/audit-handler-throws',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    const rows = await withOrg(user.orgId, (tx) =>
      tx
        .select()
        .from(securityAlerts)
        .where(sql`alert_type = 'audit_throw_probe'`)
    )
    const audits = await withOrg(user.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'test.audit_handler_throws'))
    )

    expect(res.statusCode).toBe(500)
    expect(rows).toHaveLength(0)
    expect(audits).toHaveLength(0)
    await app.close()
  })

  it('strips forbidden nested audit payload fields before writing audit rows', async () => {
    const app = await createApp({ logger: false })
    const circularPayload: Record<string, unknown> = {}
    circularPayload.self = circularPayload
    secureRoute(app, {
      method: 'POST',
      url: '/api/v1/test/audit-sanitize',
      security: {
        writeAuditEvent: {
          eventType: 'test.audit_sanitize',
          resourceType: 'security_alert',
          payload: () => ({
            safeField: 'kept',
            password: 'drop-me',
            nested: { secretValue: 'drop-me-too', safeNested: 'kept-too' },
            circular: circularPayload,
          }),
        },
      },
      handler: async () => ({ data: { ok: true } }),
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('audit-sanitize'),
      password: PASSWORD,
      orgName: `SecureRoute Audit Sanitize ${randomUUID()}`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/test/audit-sanitize',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    const [audit] = await withOrg(user.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'test.audit_sanitize'))
    )

    expect(res.statusCode).toBe(200)
    expect(audit?.payload).toEqual({
      safeField: 'kept',
      nested: { safeNested: 'kept-too' },
      circular: { self: '[Circular]' },
    })
    await app.close()
  })

  it('rolls back handler writes when same-transaction audit writing fails', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'POST',
      url: '/api/v1/test/audit-rollback',
      security: {
        writeAuditEvent: { eventType: 'test.audit_rollback', resourceType: 'security_alert' },
      },
      auditWriter: async () => {
        throw new Error('forced audit failure')
      },
      handler: async (ctx) => {
        await ctx.tx.insert(securityAlerts).values({
          orgId: ctx.auth.orgId,
          alertType: 'audit_rollback_probe',
          severity: 'info',
        })
        return { data: { inserted: true } }
      },
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('audit-rollback'),
      password: PASSWORD,
      orgName: `SecureRoute Audit Rollback ${randomUUID()}`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/test/audit-rollback',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    const rows = await withOrg(user.orgId, (tx) =>
      tx
        .select()
        .from(securityAlerts)
        .where(sql`alert_type = 'audit_rollback_probe'`)
    )

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'audit_write_failed' })
    expect(rows).toHaveLength(0)
    await app.close()
  })

  it('rolls back handler writes when the default audit insert fails', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'POST',
      url: '/api/v1/test/audit-persistence-fail/:alertId',
      security: {
        writeAuditEvent: {
          eventType: 'test.audit_persistence_failure',
          resourceType: 'security_alert',
          resourceIdFromParams: 'alertId',
        },
      },
      handler: async (ctx) => {
        await ctx.tx.insert(securityAlerts).values({
          orgId: ctx.auth.orgId,
          alertType: 'audit_persistence_failure_probe',
          severity: 'info',
        })
        return { data: { inserted: true } }
      },
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('audit-persistence-failure'),
      password: PASSWORD,
      orgName: `SecureRoute Audit Persistence Failure ${randomUUID()}`,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/test/audit-persistence-fail/not-a-uuid',
      headers: { cookie: cookieHeader(user.cookies) },
    })
    const rows = await withOrg(user.orgId, (tx) =>
      tx
        .select()
        .from(securityAlerts)
        .where(sql`alert_type = 'audit_persistence_failure_probe'`)
    )
    const audits = await withOrg(user.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'test.audit_persistence_failure'))
    )

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'audit_write_failed' })
    expect(rows).toHaveLength(0)
    expect(audits).toHaveLength(0)
    await app.close()
  })

  it('rolls back handler writes when audit HMAC key material is unavailable', async () => {
    const app = await createApp({ logger: false })
    secureRoute(app, {
      method: 'POST',
      url: '/api/v1/test/audit-key-fail',
      security: {
        writeAuditEvent: { eventType: 'test.audit_key_failure', resourceType: 'security_alert' },
      },
      handler: async (ctx) => {
        await ctx.tx.insert(securityAlerts).values({
          orgId: ctx.auth.orgId,
          alertType: 'audit_key_failure_probe',
          severity: 'info',
        })
        return { data: { inserted: true } }
      },
    })
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail('audit-key-failure'),
      password: PASSWORD,
      orgName: `SecureRoute Audit Key Failure ${randomUUID()}`,
    })

    zeroKeys()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/test/audit-key-fail',
        headers: { cookie: cookieHeader(user.cookies) },
      })
      const rows = await withOrg(user.orgId, (tx) =>
        tx
          .select()
          .from(securityAlerts)
          .where(sql`alert_type = 'audit_key_failure_probe'`)
      )
      const audits = await withOrg(user.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'test.audit_key_failure'))
      )

      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ code: 'audit_write_failed' })
      expect(rows).toHaveLength(0)
      expect(audits).toHaveLength(0)
    } finally {
      await unsealVault({ passphrase: TEST_PASSPHRASE })
      await app.close()
    }
  })
})
