import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { machineUsers } from '@project-vault/db/schema'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { buildCredentialSharingHost } from '../../lib/credential-sharing-host.js'
import { buildExportBundle } from '../project-export/service.js'
import { parseExportBundle } from '../project-export/import-service.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

/**
 * Story 73.9 AC-4 — a host-managed machine user can never be administered or keyed through PV's
 * machine-user routes: every by-id route answers exactly as for an unknown id, project lists and
 * project export never include it, and an import bundle cannot describe one.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'machine-user-host-managed',
  orgNamePrefix: 'Machine User Host Managed',
})

const EXTENSION_NAME = 'com.centralizeme.module-pack'

type ByIdRoute = { method: 'GET' | 'POST' | 'DELETE'; path: string; payload?: object }

function byIdRoutes(machineUserId: string, keyId: string): ByIdRoute[] {
  const base = `/api/v1/machine-users/${machineUserId}`
  return [
    { method: 'GET', path: base },
    { method: 'POST', path: `${base}/deactivate` },
    { method: 'POST', path: `${base}/api-keys`, payload: { name: 'attached-key' } },
    { method: 'GET', path: `${base}/api-keys` },
    { method: 'DELETE', path: `${base}/api-keys/${keyId}` },
    { method: 'POST', path: `${base}/api-keys/${keyId}/rotate`, payload: {} },
    { method: 'POST', path: `${base}/api-keys/${keyId}/emergency-revoke`, payload: {} },
    { method: 'POST', path: `${base}/api-keys/${keyId}/extend-dormancy`, payload: {} },
  ]
}

describe('host-managed machine users behind the machine-user routes (Story 73.9 AC-4)', () => {
  let app: TestApp
  let owner: Awaited<ReturnType<typeof registerOwner>>
  let projectId: string
  let hostManagedId: string

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
    owner = await registerOwner(app, 'host-managed-routes')
    projectId = await createProjectViaApi(app, owner.cookies, 'host-managed-routes')
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/machine-users`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'ci-deploy-bot', role: 'member' },
    })
    expect(created.statusCode).toBe(201)
    hostManagedId = (
      await buildCredentialSharingHost({
        name: EXTENSION_NAME,
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
      }).provisionMachineUser({ organizationId: owner.orgId })
    ).machineUserId
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  function send(route: ByIdRoute) {
    return app.inject({
      method: route.method,
      url: route.path,
      headers: { cookie: cookieHeader(owner.cookies) },
      ...(route.payload ? { payload: route.payload } : {}),
    })
  }

  it('every by-id route answers a host-managed id exactly like an unknown id', async () => {
    const unknownId = randomUUID()
    const pairs = byIdRoutes(unknownId, randomUUID()).map((unknown) => ({
      unknown,
      hostManaged: { ...unknown, path: unknown.path.replace(unknownId, hostManagedId) },
    }))
    const outcomes = await pairs.reduce<Promise<Array<{ path: string; same: boolean }>>>(
      async (previous, pair) => {
        const done = await previous
        const unknown = await send(pair.unknown)
        const hostManaged = await send(pair.hostManaged)
        expect(unknown.statusCode).toBeGreaterThanOrEqual(400)
        return [
          ...done,
          {
            path: pair.hostManaged.path,
            same:
              unknown.statusCode === hostManaged.statusCode && unknown.body === hostManaged.body,
          },
        ]
      },
      Promise.resolve([])
    )
    expect(outcomes.filter((outcome) => !outcome.same)).toEqual([])

    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(machineUsers).where(eq(machineUsers.id, hostManagedId))
    )
    expect(row).toMatchObject({ hostManaged: true, deactivatedAt: null })
  })

  it('the project list never includes it', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/machine-users`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(list.statusCode).toBe(200)
    const ids = list.json<{ data: { items: Array<{ id: string }> } }>().data.items.map((i) => i.id)
    expect(ids).toHaveLength(1)
    expect(ids).not.toContain(hostManagedId)
  })

  it('project export never exports it, and an import bundle cannot describe one', async () => {
    const { bundle } = await withOrg(owner.orgId, (tx) =>
      buildExportBundle(tx, { orgId: owner.orgId, projectId })
    )
    expect(bundle.machineUsers.map((m) => m.name)).toEqual(['ci-deploy-bot'])

    const withHostManaged = {
      ...bundle,
      machineUsers: [
        { name: EXTENSION_NAME, description: null, role: 'viewer', hostManaged: true },
      ],
    }
    expect(parseExportBundle(withHostManaged)).toEqual({ status: 'invalid_payload' })
  })
})
