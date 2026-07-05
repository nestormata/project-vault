import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, organizations, securityAlerts } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'dormancy-admin',
  orgNamePrefix: 'Dormancy Admin',
})

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}

async function setupMachineUserAndKey(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<{ machineUserId: string; keyId: string }> {
  const muRes = await app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
  })
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id
  const keyRes = await app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'k' },
  })
  const keyId = keyRes.json<{ data: { id: string } }>().data.id
  return { machineUserId, keyId }
}

describe('POST .../api-keys/:keyId/extend-dormancy (AC-22)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('sets dormancySnoozedUntil ~N days in the future', async () => {
    const owner = await registerOwner(app, 'extend')
    const projectId = await createProjectViaApi(app, owner.cookies, 'extend-dormancy')
    const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

    const res = await app.inject({
      method: 'POST',
      url: `${apiKeysUrl(machineUserId)}/${keyId}/extend-dormancy`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { days: 30 },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { keyId: string; dormancySnoozedUntil: string } }>().data
    expect(body.keyId).toBe(keyId)
    const daysAhead = (new Date(body.dormancySnoozedUntil).getTime() - Date.now()) / 86_400_000
    expect(daysAhead).toBeGreaterThan(29)
    expect(daysAhead).toBeLessThan(31)

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(apiKeys).where(eq(apiKeys.id, keyId))
    )
    expect(row?.dormancySnoozedUntil).not.toBeNull()
  })

  it('rejects days of 0, negative, or over 365', async () => {
    const owner = await registerOwner(app, 'extend-validation')
    const projectId = await createProjectViaApi(app, owner.cookies, 'extend-dormancy-validation')
    const { machineUserId, keyId } = await setupMachineUserAndKey(app, owner.cookies, projectId)

    for (const days of [0, -1, 400]) {
      const res = await app.inject({
        method: 'POST',
        url: `${apiKeysUrl(machineUserId)}/${keyId}/extend-dormancy`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { days },
      })
      expect(res.statusCode).toBe(422)
    }
  })
})

describe('PATCH /api/v1/organizations/:orgId/machine-key-settings (D8)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('updates the dormancy threshold to an allowed value', async () => {
    const owner = await registerOwner(app, 'settings')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/machine-key-settings`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { machineKeyDormancyThresholdDays: 180 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { orgId: owner.orgId, machineKeyDormancyThresholdDays: 180 },
    })

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, owner.orgId))
    )
    expect(row?.machineKeyDormancyThresholdDays).toBe(180)
  })

  it('rejects a value outside the 30/60/90/180 enum', async () => {
    const owner = await registerOwner(app, 'settings-invalid')

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${owner.orgId}/machine-key-settings`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { machineKeyDormancyThresholdDays: 45 },
    })

    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/v1/security-alerts/:alertId/dismiss (AC-22)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function insertDormantAlert(orgId: string, keyId: string): Promise<string> {
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .insert(securityAlerts)
        .values({
          orgId,
          alertType: 'machine_key.dormant',
          severity: 'warning',
          payload: {
            keyId,
            machineUserId: randomUUID(),
            machineUserName: 'bot',
            lastUsedAt: null,
            projectId: randomUUID(),
            keyName: 'k',
          },
          status: 'delivered',
        })
        .returning({ id: securityAlerts.id })
    )
    if (!row) throw new Error('expected security alert to be inserted')
    return row.id
  }

  it('dismisses an alert with a reason', async () => {
    const owner = await registerOwner(app, 'dismiss')
    const alertId = await insertDormantAlert(owner.orgId, randomUUID())

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: 'Known seasonal batch job, runs quarterly' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { id: alertId, status: 'dismissed' } })

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(securityAlerts).where(eq(securityAlerts.id, alertId))
    )
    expect(row?.status).toBe('dismissed')
    expect(row?.dismissalReason).toBe('Known seasonal batch job, runs quarterly')
    expect(row?.dismissedAt).not.toBeNull()
  })

  it('rejects an empty reason', async () => {
    const owner = await registerOwner(app, 'dismiss-empty-reason')
    const alertId = await insertDormantAlert(owner.orgId, randomUUID())

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: '' },
    })

    expect(res.statusCode).toBe(422)
  })

  it('returns 404 for a nonexistent alertId', async () => {
    const owner = await registerOwner(app, 'dismiss-not-found')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${randomUUID()}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: 'irrelevant' },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'alert_not_found' })
  })

  it('returns 409 when dismissing an already-dismissed alert', async () => {
    const owner = await registerOwner(app, 'dismiss-twice')
    const alertId = await insertDormantAlert(owner.orgId, randomUUID())

    await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: 'first dismissal' },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/security-alerts/${alertId}/dismiss`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { reason: 'second dismissal' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'alert_already_dismissed' })
  })
})
