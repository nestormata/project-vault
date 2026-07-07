import { describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { systemSettings } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
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
