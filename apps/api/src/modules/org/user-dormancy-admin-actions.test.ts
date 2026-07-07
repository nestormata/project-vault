import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, securityAlerts } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'user-dormancy-admin',
  orgNamePrefix: 'User Dormancy Admin',
})

const PASSPHRASE = 'user-dormancy-admin-actions-passphrase'

async function insertDormantUserAlert(orgId: string, userId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(securityAlerts)
      .values({
        orgId,
        alertType: 'user.dormant',
        severity: 'warning',
        payload: {
          userId,
          displayName: 'dormant-user@example.com',
          orgRole: 'member',
          lastActiveAt: null,
        },
        status: 'delivered',
      })
      .returning({ id: securityAlerts.id })
  )
  if (!row) throw new Error('expected security alert to be inserted')
  return row.id
}

/**
 * Story 8.3 D6/AC-14 — "admin can dismiss a dormant-user alert" needs zero new dismiss code: the
 * existing generic `POST /api/v1/security-alerts/:alertId/dismiss` endpoint already handles any
 * alertType. These tests confirm the existing endpoint's coverage extends to `user.dormant`.
 */
describe('POST /api/v1/security-alerts/:alertId/dismiss for user.dormant alerts (D6/AC-14)', () => {
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

  it('dismisses a user.dormant alert with a reason', async () => {
    const owner = await registerOwner(app, 'dismiss')
    const alertId = await insertDormantUserAlert(owner.orgId, randomUUID())

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: 'Contractor on planned sabbatical, returns August' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { id: alertId, status: 'dismissed' } })

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(securityAlerts).where(eq(securityAlerts.id, alertId))
    )
    expect(row?.status).toBe('dismissed')
    expect(row?.dismissalReason).toBe('Contractor on planned sabbatical, returns August')
  })

  it('rejects an empty reason (AC-14 edge case)', async () => {
    const owner = await registerOwner(app, 'dismiss-empty')
    const alertId = await insertDormantUserAlert(owner.orgId, randomUUID())

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: '' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('an admin can also dismiss a user.dormant alert', async () => {
    const owner = await registerOwner(app, 'dismiss-admin')
    const admin = await addUserToOrg(app, owner.orgId, 'dismiss-admin-member', {
      orgRole: 'admin',
    })
    const alertId = await insertDormantUserAlert(owner.orgId, randomUUID())

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { reason: 'Confirmed with the user directly' },
    })

    expect(res.statusCode).toBe(200)
  })

  it('renders the payload via GET /org/security-alerts without dropping the row (D6)', async () => {
    const owner = await registerOwner(app, 'render')
    const targetUserId = randomUUID()
    await insertDormantUserAlert(owner.orgId, targetUserId)

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/org/security-alerts',
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { items: { alertType: string; payload: unknown }[] } }>().data
    const dormantItem = body.items.find((item) => item.alertType === 'user.dormant')
    expect(dormantItem).toBeDefined()
    expect(dormantItem?.payload).toMatchObject({ userId: targetUserId })
  })
})

/**
 * Story 8.3 D1/AC-15 — "admin can deactivate a dormant user" reuses Story 4.3's existing,
 * unmodified POST /users/:userId/deactivate. This test confirms that action, plus the AC-15 edge
 * case that dismiss and deactivate are independent (deactivating leaves the alert untouched).
 */
describe('deactivating a dormant user does not implicitly dismiss their alert (AC-15)', () => {
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

  it('deactivates the dormant user while leaving their pending alert untouched', async () => {
    const owner = await registerOwner(app, 'deactivate')
    const member = await addUserToOrg(app, owner.orgId, 'deactivate-member', { orgRole: 'member' })
    const alertId = await insertDormantUserAlert(owner.orgId, member.userId)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/org/users/${member.userId}/deactivate`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(res.statusCode).toBe(200)

    const [membership] = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ status: orgMemberships.status })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, member.userId))
    )
    expect(membership?.status).toBe('deactivated')

    const [alert] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(securityAlerts).where(eq(securityAlerts.id, alertId))
    )
    expect(alert?.status).toBe('delivered')
  })
})
