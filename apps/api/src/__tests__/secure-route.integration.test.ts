import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import { secureRoute } from '../lib/secure-route.js'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from './helpers/auth-test-helpers.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
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
})
