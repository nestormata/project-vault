import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, notificationQueue } from '@project-vault/db/schema'
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
  emailPrefix: 'cache-activated',
  orgNamePrefix: 'Cache Activated',
})

const CACHE_ACTIVATED_URL = '/api/v1/machine/cache-activated'

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}

async function issueMachineUserAndKey(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<{ machineUserId: string; key: string }> {
  const muRes = await app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
  })
  expect(muRes.statusCode).toBe(201)
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id

  const keyRes = await app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'ci-key' },
  })
  expect(keyRes.statusCode).toBe(201)
  const key = keyRes.json<{ data: { key: string } }>().data.key

  return { machineUserId, key }
}

async function exchangeForMachineJwt(app: TestApp, key: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/machine-token',
    headers: { authorization: `Bearer ${key}` },
  })
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { accessToken: string } }>().data.accessToken
}

describe('POST /api/v1/machine/cache-activated (D13/AC-15)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('returns 202 recorded:true and writes a machine_cache.activated audit row + alert', async () => {
    const owner = await registerOwner(app, 'happy')
    const projectId = await createProjectViaApi(app, owner.cookies, 'cache-activated-happy')
    const { machineUserId, key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
    const jwt = await exchangeForMachineJwt(app, key)

    const activatedAt = new Date().toISOString()
    const res = await app.inject({
      method: 'POST',
      url: CACHE_ACTIVATED_URL,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { activatedAt, threshold: 3 },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ data: { recorded: true } })

    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'machine_cache.activated'))
    )
    const row = rows.find(
      (r) => (r.payload as Record<string, unknown>)?.['machineUserId'] === machineUserId
    )
    expect(row).toBeDefined()
    expect(row?.actorType).toBe('machine_user')
    expect(row?.actorTokenId).toBeNull()
    expect(row?.payload).toMatchObject({ activatedAt, threshold: 3, machineUserId })

    const queued = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(notificationQueue)
        .where(eq(notificationQueue.templateId, 'machine_cache.activated'))
    )
    expect(queued.length).toBeGreaterThan(0)
  })

  it('returns 401 access_token_missing without an Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: CACHE_ACTIVATED_URL,
      payload: { activatedAt: new Date().toISOString(), threshold: 3 },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'access_token_missing' })
  })

  it('returns 401 invalid_machine_token for a garbage bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: CACHE_ACTIVATED_URL,
      headers: { authorization: 'Bearer not-a-real-jwt' },
      payload: { activatedAt: new Date().toISOString(), threshold: 3 },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'invalid_machine_token' })
  })

  it('returns 422 validation_error for a missing threshold', async () => {
    const owner = await registerOwner(app, 'validation')
    const projectId = await createProjectViaApi(app, owner.cookies, 'cache-activated-validation')
    const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
    const jwt = await exchangeForMachineJwt(app, key)

    const res = await app.inject({
      method: 'POST',
      url: CACHE_ACTIVATED_URL,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { activatedAt: new Date().toISOString() },
    })

    expect(res.statusCode).toBe(422)
  })
})
