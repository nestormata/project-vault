import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  emailPrefix: 'active-keys',
  orgNamePrefix: 'Active Keys',
})

function activeKeysUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users/active-keys`
}
function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}
function archiveUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/archive`
}

describe('AC-23: archival guard closure', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('GET .../machine-users/active-keys lists a project with one active key', async () => {
    const owner = await registerOwner(app, 'list-active')
    const projectId = await createProjectViaApi(app, owner.cookies, 'active-keys-list')

    const muRes = await app.inject({
      method: 'POST',
      url: machineUsersUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
    })
    const machineUserId = muRes.json<{ data: { id: string } }>().data.id
    const keyRes = await app.inject({
      method: 'POST',
      url: apiKeysUrl(machineUserId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'k' },
    })
    const keyId = keyRes.json<{ data: { id: string } }>().data.id

    const res = await app.inject({
      method: 'GET',
      url: activeKeysUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { items: [{ machineUserId, keyId }], total: 1 },
    })
  })

  it('blocks archival with 409 { error: active_machine_user_keys, machineUserIds } while a key is active', async () => {
    const owner = await registerOwner(app, 'block-archive')
    const projectId = await createProjectViaApi(app, owner.cookies, 'active-keys-block')

    const muRes = await app.inject({
      method: 'POST',
      url: machineUsersUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
    })
    const machineUserId = muRes.json<{ data: { id: string } }>().data.id
    await app.inject({
      method: 'POST',
      url: apiKeysUrl(machineUserId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'k' },
    })

    const archiveRes = await app.inject({
      method: 'POST',
      url: archiveUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    expect(archiveRes.statusCode).toBe(409)
    expect(archiveRes.json()).toMatchObject({
      error: 'active_machine_user_keys',
      machineUserIds: [machineUserId],
    })
  })

  it('allows archival once the only key is revoked', async () => {
    const owner = await registerOwner(app, 'unblock-archive')
    const projectId = await createProjectViaApi(app, owner.cookies, 'active-keys-unblock')

    const muRes = await app.inject({
      method: 'POST',
      url: machineUsersUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
    })
    const machineUserId = muRes.json<{ data: { id: string } }>().data.id
    const keyRes = await app.inject({
      method: 'POST',
      url: apiKeysUrl(machineUserId),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'k' },
    })
    const keyId = keyRes.json<{ data: { id: string } }>().data.id

    await app.inject({
      method: 'DELETE',
      url: `${apiKeysUrl(machineUserId)}/${keyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    const archiveRes = await app.inject({
      method: 'POST',
      url: archiveUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(archiveRes.statusCode).toBe(200)
  })

  it('returns 404 for active-keys on a projectId belonging to a different org', async () => {
    const ownerA = await registerOwner(app, 'org-a')
    const ownerB = await registerOwner(app, 'org-b')
    const projectA = await createProjectViaApi(app, ownerA.cookies, 'active-keys-org-a')

    const res = await app.inject({
      method: 'GET',
      url: activeKeysUrl(projectA),
      headers: { cookie: cookieHeader(ownerB.cookies) },
    })

    expect(res.statusCode).toBe(404)
  })
})
