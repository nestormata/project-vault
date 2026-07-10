import { describe, expect, it } from 'vitest'
import { createTestUser } from '@project-vault/db/test-helpers'
import { NOTIFICATION_ALERT_TYPES } from '@project-vault/shared'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { loginExistingUserInOrg } from '../../__tests__/helpers/org-role-test-helpers.js'

const { initVault } = await bootstrapRouteIntegrationTest()

const PREFS_URL = '/api/v1/users/me/notification-preferences'
const ROUTING_URL = '/api/v1/org/notification-routing'
const FAILED_AUTH_ALERT = 'security.failed_auth_threshold'
const MFA_RECOVERY_ALERT = 'security.mfa_recovery_used'

const TEST_PASSPHRASE = 'notifications-prefs-passphrase'
const PASSWORD = 'correct-horse-battery-staple'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function authHeaders(cookies: CookieJar) {
  return { cookie: cookieHeader(cookies) }
}

describe.sequential('notification preferences routes', () => {
  suite.registerLifecycle()

  it('GET /api/v1/users/me/notification-preferences returns defaults', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-prefs-defaults',
      orgNamePrefix: 'Notify Prefs Defaults',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'GET',
      url: PREFS_URL,
      headers: authHeaders(owner.cookies),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: unknown[] }
    expect(body.data.length).toBeGreaterThanOrEqual(NOTIFICATION_ALERT_TYPES.length * 2)
  }, 20_000)

  it('PATCH updates a single preference', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-prefs-patch',
      orgNamePrefix: 'Notify Prefs Patch',
      password: PASSWORD,
    })

    const patchRes = await suite.app.inject({
      method: 'PATCH',
      url: PREFS_URL,
      headers: { ...authHeaders(owner.cookies), 'content-type': 'application/json' },
      payload: [
        {
          alertType: FAILED_AUTH_ALERT,
          channel: 'email',
          frequency: 'digest_daily',
          minSeverity: 'critical',
        },
      ],
    })
    expect(patchRes.statusCode).toBe(200)

    const getRes = await suite.app.inject({
      method: 'GET',
      url: PREFS_URL,
      headers: authHeaders(owner.cookies),
    })
    const emailPref = (
      getRes.json() as { data: Array<{ alertType: string; channel: string; frequency: string }> }
    ).data.find((p) => p.alertType === FAILED_AUTH_ALERT && p.channel === 'email')
    expect(emailPref?.frequency).toBe('digest_daily')
  }, 20_000)

  it('PATCH persists a none opt-out and returns it on subsequent GET', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-prefs-none',
      orgNamePrefix: 'Notify Prefs None',
      password: PASSWORD,
    })

    const patchRes = await suite.app.inject({
      method: 'PATCH',
      url: PREFS_URL,
      headers: { ...authHeaders(owner.cookies), 'content-type': 'application/json' },
      payload: [
        {
          alertType: MFA_RECOVERY_ALERT,
          channel: 'none',
          frequency: 'immediate',
          minSeverity: 'warning',
        },
      ],
    })
    expect(patchRes.statusCode).toBe(200)

    const getRes = await suite.app.inject({
      method: 'GET',
      url: PREFS_URL,
      headers: authHeaders(owner.cookies),
    })
    expect(getRes.statusCode).toBe(200)
    expect(
      (
        getRes.json() as {
          data: Array<{
            alertType: string
            channel: string
            frequency: string
            minSeverity: string
          }>
        }
      ).data.filter((p) => p.alertType === MFA_RECOVERY_ALERT)
    ).toEqual([
      {
        alertType: MFA_RECOVERY_ALERT,
        channel: 'none',
        frequency: 'immediate',
        minSeverity: 'warning',
      },
    ])
  }, 20_000)

  it('PATCH rejects contradictory none-plus-real-channel payloads for the same alert type', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-prefs-patch-contradictory',
      orgNamePrefix: 'Notify Prefs Patch Contradictory',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'PATCH',
      url: PREFS_URL,
      headers: { ...authHeaders(owner.cookies), 'content-type': 'application/json' },
      payload: [
        {
          alertType: FAILED_AUTH_ALERT,
          channel: 'none',
          frequency: 'immediate',
          minSeverity: 'warning',
        },
        {
          alertType: FAILED_AUTH_ALERT,
          channel: 'email',
          frequency: 'immediate',
          minSeverity: 'warning',
        },
      ],
    })

    expect(res.statusCode).toBe(422)
  }, 20_000)

  it('PUT rejects contradictory none-plus-real-channel payloads for the same alert type', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-prefs-put-contradictory',
      orgNamePrefix: 'Notify Prefs Put Contradictory',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'PUT',
      url: PREFS_URL,
      headers: { ...authHeaders(owner.cookies), 'content-type': 'application/json' },
      payload: [
        {
          alertType: FAILED_AUTH_ALERT,
          channel: 'none',
          frequency: 'immediate',
          minSeverity: 'warning',
        },
        {
          alertType: FAILED_AUTH_ALERT,
          channel: 'email',
          frequency: 'immediate',
          minSeverity: 'warning',
        },
      ],
    })

    expect(res.statusCode).toBe(422)
  }, 20_000)

  it('GET /api/v1/org/notification-routing returns 403 for member', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-routing-member',
      orgNamePrefix: 'Notify Routing Member',
      password: PASSWORD,
    })
    const memberUserId = await createTestUser('notify-route-member')
    const memberCookies = await loginExistingUserInOrg(suite.app, {
      userId: memberUserId,
      orgId: owner.orgId,
      role: 'member',
    })

    const res = await suite.app.inject({
      method: 'GET',
      url: ROUTING_URL,
      headers: authHeaders(memberCookies),
    })
    expect(res.statusCode).toBe(403)
  }, 20_000)

  it('GET /api/v1/org/notification-routing returns owner defaults for admin', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-routing-admin',
      orgNamePrefix: 'Notify Routing Admin',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'GET',
      url: ROUTING_URL,
      headers: authHeaders(owner.cookies),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: Array<{ routeTo: string }> }
    expect(body.data.every((r) => r.routeTo === 'owner')).toBe(true)
  }, 20_000)

  it('PUT /api/v1/org/notification-routing rejects security.* to member', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'notify-routing-reject',
      orgNamePrefix: 'Notify Routing Reject',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'PUT',
      url: ROUTING_URL,
      headers: { ...authHeaders(owner.cookies), 'content-type': 'application/json' },
      payload: [{ alertType: FAILED_AUTH_ALERT, routeTo: 'member' }],
    })

    expect(res.statusCode).toBe(422)
  }, 20_000)
})
