import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, systemSettings, users } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { registerPlatformOperator } from '../../__tests__/helpers/platform-operator-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'

const { initVault } = await bootstrapRouteIntegrationTest()

const TEST_PASSPHRASE = 'platform-admin-resource-usage-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const RESOURCE_USAGE_URL = '/api/v1/admin/resource-usage'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

describe.sequential('Story 9.2 platform-admin resource-usage route', () => {
  suite.registerLifecycle()

  it('AC-1: 401 with no auth header', async () => {
    const res = await suite.app.inject({ method: 'GET', url: RESOURCE_USAGE_URL })
    expect(res.statusCode).toBe(401)
  })

  it('Story 9.8 AC-M6: GET returns 403 mfa_required for an unenrolled platform operator', async () => {
    const registered = await registerAndLoginViaApi(suite.app, {
      email: `resource-usage-no-mfa-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Resource Usage No MFA ${randomUUID()}`,
    })
    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx
        .update(users)
        .set({ isPlatformOperator: true })
        .where(eq(users.id, registered.userId))
    })
    await withOrg(registered.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, registered.userId))
    )

    const res = await suite.app.inject({
      method: 'GET',
      url: RESOURCE_USAGE_URL,
      headers: { cookie: cookieHeader(registered.cookies) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('Story 9.8 AC-M9: GET returns platform_operator_required for an enrolled non-operator', async () => {
    const { enrollUserWithMfa } = await import('../../__tests__/helpers/mfa-enroll-test-helpers.js')
    const nonOperator = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'resource-usage-non-operator',
      orgNamePrefix: 'Resource Usage Non Operator',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'GET',
      url: RESOURCE_USAGE_URL,
      headers: { cookie: cookieHeader(nonOperator.cookies) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'platform_operator_required' })
  })

  it('AC-12: happy path — honest nulls for auditLogEntries/storageBytes limits', async () => {
    const operator = await registerPlatformOperator(suite.app, {
      emailPrefix: 'resource-usage-happy',
      orgNamePrefix: 'Resource Usage Happy',
      password: PASSWORD,
    })
    // Other test files sharing this DB may have left a system_settings override in place —
    // clear it so this test observes the true instance-default maxOrgs (10).
    await getDb().delete(systemSettings)
    const res = await suite.app.inject({
      method: 'GET',
      url: RESOURCE_USAGE_URL,
      headers: { cookie: cookieHeader(operator.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      orgs: { current: number; limit: number | null }
      usersPerOrg: { orgId: string; current: number; limit: number | null }[]
      auditLogEntries: { current: number; limit: number | null }
      storageBytes: { current: number; limit: number | null }
      auditLogStorage: { currentBytes: number; limitBytes: number; utilizationPct: number }
    }>()
    expect(body.orgs.current).toBeGreaterThanOrEqual(1)
    expect(body.orgs.limit).toBe(10)
    expect(body.auditLogEntries.limit).toBeNull()
    expect(body.storageBytes.limit).toBeNull()
    expect(body.auditLogStorage.limitBytes).toBeGreaterThan(0)
    expect(body.usersPerOrg.length).toBeGreaterThan(0)
    // AC-12: the platform operator's own registration already wrote an audit entry.
    expect(body.auditLogEntries.current).toBeGreaterThanOrEqual(1)
  })
})
