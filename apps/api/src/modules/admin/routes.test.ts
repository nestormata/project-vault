import { describe, expect, it } from 'vitest'
import nodemailer from 'nodemailer'
import { createTestUser } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { loginExistingUserInOrg } from '../../__tests__/helpers/org-role-test-helpers.js'
import {
  setEmailTransportForTesting,
  resetEmailTransportForTesting,
} from '../../workers/notification-email.js'
import type { createApp } from '../../app.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'admin-notifications-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const TEST_URL = '/api/v1/admin/notifications/test'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

async function postNotificationTest(app: TestApp, cookies: CookieJar) {
  return app.inject({
    method: 'POST',
    url: TEST_URL,
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('POST /api/v1/admin/notifications/test', () => {
  suite.registerLifecycle()

  it('returns not_configured when SMTP and Slack are absent', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'admin-notify-not-configured',
      orgNamePrefix: 'Admin Notify Not Configured',
      password: PASSWORD,
    })
    const res = await postNotificationTest(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ email: 'not_configured', slack: 'not_configured' })
  }, 20_000)

  it('returns 403 when caller is member (not admin or owner)', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'admin-notify-member',
      orgNamePrefix: 'Admin Notify Member',
      password: PASSWORD,
    })
    const memberUserId = await createTestUser('admin-route-member')
    const memberCookies = await loginExistingUserInOrg(suite.app, {
      userId: memberUserId,
      orgId: owner.orgId,
      role: 'member',
    })

    const res = await postNotificationTest(suite.app, memberCookies)
    expect(res.statusCode).toBe(403)
  }, 20_000)

  it('returns delivered when SMTP sends successfully (mock transport)', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'admin-notify-smtp-delivered',
      orgNamePrefix: 'Admin Notify SMTP Delivered',
      password: PASSWORD,
    })
    setEmailTransportForTesting(nodemailer.createTransport({ jsonTransport: true }))

    const res = await postNotificationTest(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ email: 'delivered' })
    resetEmailTransportForTesting()
  }, 20_000)

  it('returns failed when SMTP connection is refused', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'admin-notify-smtp-failed',
      orgNamePrefix: 'Admin Notify SMTP Failed',
      password: PASSWORD,
    })
    setEmailTransportForTesting(nodemailer.createTransport({ host: '127.0.0.1', port: 1 }))

    const res = await postNotificationTest(suite.app, owner.cookies)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ email: 'failed' })
    resetEmailTransportForTesting()
  }, 20_000)
})
