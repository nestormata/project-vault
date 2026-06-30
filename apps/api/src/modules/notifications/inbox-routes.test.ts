import { describe, expect, it } from 'vitest'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { enrollUserWithMfa } from '../../__tests__/helpers/mfa-enroll-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { loginExistingUserInOrg } from '../../__tests__/helpers/org-role-test-helpers.js'
import { seedInboxEntryForTest } from '../../workers/notification-inbox.js'

const { initVault } = await bootstrapRouteIntegrationTest()

const INBOX_URL = '/api/v1/notifications/inbox'
const USERS_ME_URL = '/api/v1/users/me'
const TEST_PASSPHRASE = 'inbox-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function authHeaders(cookies: CookieJar) {
  return { cookie: cookieHeader(cookies) }
}

describe.sequential('notification inbox routes', () => {
  suite.registerLifecycle()

  it('GET /api/v1/notifications/inbox returns empty array when no inbox entries', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'inbox-empty',
      orgNamePrefix: 'Inbox Empty',
      password: PASSWORD,
    })

    const res = await suite.app.inject({
      method: 'GET',
      url: INBOX_URL,
      headers: authHeaders(owner.cookies),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [], page: 1, limit: 20 })
  }, 20_000)

  it('GET /api/v1/users/me includes notifications.unreadCount', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'users-me-unread',
      orgNamePrefix: 'Users Me Unread',
      password: PASSWORD,
    })

    await seedInboxEntryForTest(owner.orgId, owner.userId)

    const res = await suite.app.inject({
      method: 'GET',
      url: USERS_ME_URL,
      headers: authHeaders(owner.cookies),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { notifications: { unreadCount: number } } }
    expect(body.data.notifications.unreadCount).toBe(1)
  }, 20_000)

  it('POST /api/v1/notifications/inbox/:id/read marks entry as read', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'inbox-mark-read',
      orgNamePrefix: 'Inbox Mark Read',
      password: PASSWORD,
    })

    const entryId = await seedInboxEntryForTest(owner.orgId, owner.userId)
    const res = await suite.app.inject({
      method: 'POST',
      url: `${INBOX_URL}/${entryId}/read`,
      headers: authHeaders(owner.cookies),
    })
    expect(res.statusCode).toBe(204)
  }, 20_000)

  it('returns entries only for the authenticated user', async () => {
    const owner = await enrollUserWithMfa(suite.app, {
      emailPrefix: 'inbox-user-isolation',
      orgNamePrefix: 'Inbox User Isolation',
      password: PASSWORD,
    })
    const memberUserId = await createTestUser('inbox-route-member')
    const memberCookies = await loginExistingUserInOrg(suite.app, {
      userId: memberUserId,
      orgId: owner.orgId,
      role: 'member',
    })

    const ownerEntryId = await seedInboxEntryForTest(owner.orgId, owner.userId)
    const memberEntryId = await seedInboxEntryForTest(owner.orgId, memberUserId)

    const ownerRes = await suite.app.inject({
      method: 'GET',
      url: INBOX_URL,
      headers: authHeaders(owner.cookies),
    })
    const memberRes = await suite.app.inject({
      method: 'GET',
      url: INBOX_URL,
      headers: authHeaders(memberCookies),
    })

    const ownerBody = ownerRes.json() as { data: Array<{ id: string }> }
    const memberBody = memberRes.json() as { data: Array<{ id: string }> }
    expect(ownerBody.data).toHaveLength(1)
    expect(memberBody.data).toHaveLength(1)
    expect(ownerBody.data[0]?.id).toBe(ownerEntryId)
    expect(memberBody.data[0]?.id).toBe(memberEntryId)

    await deleteTestUser(memberUserId)
  }, 20_000)
})
