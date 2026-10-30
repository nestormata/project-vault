import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

/**
 * Story 69.17 (DW-606) — the project role matrix as data. Every PV write under `:projectId` is
 * listed with the minimum EFFECTIVE project role secureRoute enforces for it (`null`: no
 * project-role check). A new project write fails this test until it is added here, so the
 * matrix in docs/api-consumers.md cannot drift silently.
 */
const PROJECT_WRITE_ROLE_MATRIX: Record<string, 'member' | 'admin' | 'owner' | null> = {
  'POST /api/v1/projects/:projectId/alerts/:alertId/dismiss': 'member',
  'POST /api/v1/projects/:projectId/alerts/:alertId/snooze': 'member',
  // Archive and unarchive (project and secret) then apply archiveAuthority() in the handler: the
  // project owner row or the org owner (Story 69.20).
  'POST /api/v1/projects/:projectId/archive': 'member',
  'POST /api/v1/projects/:projectId/certificates': 'member',
  'DELETE /api/v1/projects/:projectId/certificates/:certificateId': 'member',
  'PATCH /api/v1/projects/:projectId/certificates/:certificateId': 'member',
  'POST /api/v1/projects/:projectId/credentials': 'member',
  'PATCH /api/v1/projects/:projectId/credentials/:credentialId': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/archive': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/dependencies': 'member',
  'DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId':
    'member',
  'PATCH /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/external-shares': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/nudge/dismiss': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/abandon':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/confirm':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/fail':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/retry':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/complete':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/promote':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/resume':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/retire':
    'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/shares': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/totp': 'member',
  // A sharer later demoted to viewer may still narrow exposure; the handler's sharer-or-org-admin
  // rule is the authorization for this route.
  'POST /api/v1/projects/:projectId/credentials/:credentialId/shares/:shareId/revoke': null,
  'PATCH /api/v1/projects/:projectId/credentials/:credentialId/tags': 'member',
  'PUT /api/v1/projects/:projectId/credentials/:credentialId/tags': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/unarchive': 'member',
  'POST /api/v1/projects/:projectId/credentials/:credentialId/versions': 'member',
  'POST /api/v1/projects/:projectId/credentials/import': 'member',
  'POST /api/v1/projects/:projectId/credentials/import/confirm': 'member',
  'POST /api/v1/projects/:projectId/domains': 'member',
  'DELETE /api/v1/projects/:projectId/domains/:domainId': 'member',
  'PATCH /api/v1/projects/:projectId/domains/:domainId': 'member',
  'POST /api/v1/projects/:projectId/export': 'member',
  'POST /api/v1/projects/:projectId/machine-users': 'member',
  'POST /api/v1/projects/:projectId/invitations': 'member',
  'DELETE /api/v1/projects/:projectId/invitations/:id': 'member',
  'POST /api/v1/projects/:projectId/members': 'admin',
  'DELETE /api/v1/projects/:projectId/members/:userId': 'member',
  // Story 72-9: edit, delete and restore apply archiveAuthority() in the handler (project owner row
  // or the org owner) on top of this floor.
  'PATCH /api/v1/projects/:projectId': 'member',
  'DELETE /api/v1/projects/:projectId': 'member',
  'POST /api/v1/projects/:projectId/restore': 'member',
  'POST /api/v1/projects/:projectId/service-endpoints': 'member',
  'DELETE /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId': 'member',
  'PATCH /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId': 'member',
  'POST /api/v1/projects/:projectId/services': 'member',
  'DELETE /api/v1/projects/:projectId/services/:serviceId': 'member',
  'PATCH /api/v1/projects/:projectId/services/:serviceId': 'member',
  'DELETE /api/v1/projects/:projectId/status-page': 'member',
  'POST /api/v1/projects/:projectId/status-page': 'member',
  'PUT /api/v1/projects/:projectId/status-page': 'member',
  'POST /api/v1/projects/:projectId/status-page/regenerate': 'member',
  'PUT /api/v1/projects/:projectId/tags': 'member',
  'POST /api/v1/projects/:projectId/transfer-ownership': 'member',
  'POST /api/v1/projects/:projectId/unarchive': 'member',
  'PUT /api/v1/org/users/:userId/projects/:projectId/role': 'member',
}

const MUTATING = /^(POST|PUT|PATCH|DELETE) /

type Registration = { key: string; origin: string; minimumProjectRole: string | null }
type OpenApiSpec = {
  paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>
}
type App = Awaited<ReturnType<typeof createApp>> & {
  pvSecureRouteRegistry: Map<string, Registration>
}

function openApiPathOf(routeUrl: string): string {
  return routeUrl.replaceAll(/:(\w+)/g, '{$1}')
}

describe('Story 69.17 — project write role matrix', () => {
  let app: App
  let projectWrites: Registration[]

  beforeAll(async () => {
    app = (await createApp({ logger: false })) as App
    await app.ready()
    projectWrites = [...app.pvSecureRouteRegistry.values()].filter(
      (entry) =>
        entry.origin === 'pv' && MUTATING.test(entry.key) && entry.key.includes('/:projectId')
    )
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces exactly the documented minimum project role on every PV project write', () => {
    const actual = Object.fromEntries(
      projectWrites.map((entry) => [entry.key, entry.minimumProjectRole])
    )
    expect(actual).toEqual(PROJECT_WRITE_ROLE_MATRIX)
  })

  it('documents the 403 project-role denial in the OpenAPI spec of every gated route', () => {
    const spec = app.swagger() as unknown as OpenApiSpec
    const undocumented = projectWrites
      .filter((entry) => entry.minimumProjectRole !== null)
      .filter((entry) => {
        const [method, url] = entry.key.split(' ') as [string, string]
        const operation = spec.paths[openApiPathOf(url)]?.[method.toLowerCase()]
        return operation?.responses?.['403'] === undefined
      })
      .map((entry) => entry.key)
    expect(undocumented).toEqual([])
  })
})
