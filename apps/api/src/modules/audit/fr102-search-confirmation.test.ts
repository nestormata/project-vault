import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSPHRASE = 'fr102-search-confirmation-passphrase'
const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'fr102',
  orgNamePrefix: 'FR102',
})

function searchByEventType(eventType: string) {
  return `/api/v1/org/audit/events?eventType=${encodeURIComponent(eventType)}`
}

/**
 * Story 8.3 AC-25 — FR102 ("privileged events... queryable via standard audit search") is
 * satisfied entirely by Story 4.3 (writes) + Story 8.2 (search); this story contributes only a
 * confirming integration test, no new production code.
 */
describe('FR102 — deactivation/recovery events queryable via GET /audit/events (AC-25)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('org.user_deactivated (Story 4.3) is returned by eventType search', async () => {
    const owner = await registerOwner(app, 'deactivated')
    const member = await addUserToOrg(app, owner.orgId, 'deactivated-member', {
      orgRole: 'member',
    })

    const deactivateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${member.userId}/deactivate`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(deactivateRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: searchByEventType('org.user_deactivated'),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { eventType: string; resourceId: string | null }[] }>()
    expect(body.data.some((row) => row.resourceId === member.userId)).toBe(true)
  })

  it('auth.recovery_link_sent (admin-initiated recovery, Story 4.3) is returned by eventType search', async () => {
    const owner = await registerOwner(app, 'recovery-link')
    const member = await addUserToOrg(app, owner.orgId, 'recovery-link-member', {
      orgRole: 'member',
    })

    const linkRes = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${member.userId}/recovery/send-link`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(linkRes.statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: searchByEventType('auth.recovery_link_sent'),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { eventType: string; resourceId: string | null }[] }>()
    expect(body.data.some((row) => row.resourceId === member.userId)).toBe(true)
  })

  it('auth.recovery_requested (self-service recovery, Story 4.3) is returned by eventType search', async () => {
    const email = `fr102-recovery-self-${randomUUID()}@example.com`
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: 'correct-horse-battery-staple',
      orgName: `FR102 Recovery Self ${randomUUID()}`,
    })

    const requestRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/request',
      payload: { email },
    })
    // Anti-enumeration: 202 regardless, but the write happens for a real, registered email.
    expect(requestRes.statusCode).toBe(202)

    const res = await app.inject({
      method: 'GET',
      url: searchByEventType('auth.recovery_requested'),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { eventType: string }[] }>()
    expect(body.data.length).toBeGreaterThan(0)
  })
})
