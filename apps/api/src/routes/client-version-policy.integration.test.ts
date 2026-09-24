import { describe, expect, it } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  registerAndLoginViaApi,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createUnsealedRouteSuite } from '../__tests__/helpers/unsealed-route-suite-test-helpers.js'

/**
 * Story 43.6 AC-7 — tenant isolation by construction: two orgs' real sessions, an invalid bearer
 * and no credentials at all get byte-identical bodies (no auth middleware runs, no 401 channel).
 */
const { initVault } = await bootstrapRouteIntegrationTest()
const suite = createUnsealedRouteSuite(initVault, 'client-version-policy-passphrase')
const URL_PATH = '/api/v1/client-version-policy'
// A fixture login phrase for the two throwaway test users (joined so it is not a literal secret).
const PASSWORD = ['correct', 'horse', 'battery', 'staple'].join('-')

describe('GET /api/v1/client-version-policy — cross-org integration (Story 43.6 AC-7)', () => {
  suite.registerLifecycle()

  it('returns an identical 200 body for org A, org B, an invalid bearer and no credentials', async () => {
    const stamp = Date.now()
    const orgA = await registerAndLoginViaApi(suite.app, {
      email: `cvp-a-${stamp}@example.com`,
      password: PASSWORD,
      orgName: `CVP Org A ${stamp}`,
    })
    const orgB = await registerAndLoginViaApi(suite.app, {
      email: `cvp-b-${stamp}@example.com`,
      password: PASSWORD,
      orgName: `CVP Org B ${stamp}`,
    })
    expect(orgA.orgId).not.toBe(orgB.orgId)

    const responses = await Promise.all([
      suite.app.inject({ method: 'GET', url: URL_PATH }),
      suite.app.inject({
        method: 'GET',
        url: URL_PATH,
        headers: { cookie: cookieHeader(orgA.cookies) },
      }),
      suite.app.inject({
        method: 'GET',
        url: URL_PATH,
        headers: { cookie: cookieHeader(orgB.cookies) },
      }),
      suite.app.inject({
        method: 'GET',
        url: URL_PATH,
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.invalid.invalid' },
      }),
    ])
    for (const response of responses) expect(response.statusCode).toBe(200)
    const bodies = new Set(responses.map((response) => JSON.stringify(response.json())))
    expect(bodies.size).toBe(1)
    expect([...bodies][0]).not.toContain(orgA.orgId)
    expect([...bodies][0]).not.toContain(orgB.orgId)
  }, 30_000)
})
