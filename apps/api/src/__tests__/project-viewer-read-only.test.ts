import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, count, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentials,
  orgMemberships,
  projectMemberships,
  serviceEndpoints,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
  mintOrgSessionCookies,
  type CookieJar,
} from './helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from './helpers/membership-test-helpers.js'
import { registerPlatformOperator } from './helpers/platform-operator-test-helpers.js'
import { resetVaultForTest } from './helpers/vault-test-cleanup.js'
import { bootCredentialRouteApp } from '../modules/credentials/credential-route-test-helpers.js'

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) },
}))

/**
 * Story 69.17 (DW-606) — a project `viewer` is read-only on every project write, through the real
 * app, roles and RLS. Org-role floors, the org owner/admin bypass and the cross-tenant 404 are
 * unchanged.
 */
const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'viewer-ro',
  orgNamePrefix: 'Viewer RO',
})
const PASSPHRASE = 'project-viewer-read-only-passphrase'
const FUTURE_ISO = new Date(Date.now() + 90 * 86_400_000).toISOString()
const PROJECT_ROLE_DENIED = {
  code: 'insufficient_project_role',
  message: 'Your role in this project does not permit this action',
}

type Write = {
  name: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  payload?: object
}

let app: TestApp
let owner: { userId: string; orgId: string; cookies: CookieJar }
let projectId: string
let credentialId: string
let endpointId: string

function inject(cookies: CookieJar, write: Write) {
  return app.inject({
    method: write.method,
    url: write.url,
    headers: { cookie: cookieHeader(cookies) },
    ...(write.payload ? { payload: write.payload } : {}),
  })
}

function projectWrites(): Write[] {
  const base = `/api/v1/projects/${projectId}`
  return [
    {
      name: 'create secret',
      method: 'POST',
      url: `${base}/credentials`,
      payload: { name: `k-${randomUUID()}`, value: 'v' },
    },
    {
      name: 'edit secret',
      method: 'PATCH',
      url: `${base}/credentials/${credentialId}`,
      payload: { description: 'changed' },
    },
    {
      name: 'replace secret tags',
      method: 'PUT',
      url: `${base}/credentials/${credentialId}/tags`,
      payload: { tags: ['x'] },
    },
    {
      name: 'create endpoint',
      method: 'POST',
      url: `${base}/service-endpoints`,
      payload: { name: 'API', url: 'https://api.example.com/health' },
    },
    {
      name: 'pause endpoint',
      method: 'PATCH',
      url: `${base}/service-endpoints/${endpointId}`,
      payload: { healthCheckPaused: true },
    },
    { name: 'delete endpoint', method: 'DELETE', url: `${base}/service-endpoints/${endpointId}` },
    {
      name: 'create service',
      method: 'POST',
      url: `${base}/services`,
      payload: { name: 'Hosting' },
    },
    {
      name: 'create certificate',
      method: 'POST',
      url: `${base}/certificates`,
      payload: { domain: 'c.example.com', expiresAt: FUTURE_ISO },
    },
    {
      name: 'create domain',
      method: 'POST',
      url: `${base}/domains`,
      payload: { domainName: 'd.example.com', expiresAt: FUTURE_ISO },
    },
    { name: 'replace project tags', method: 'PUT', url: `${base}/tags`, payload: { tags: ['x'] } },
    { name: 'create status page', method: 'POST', url: `${base}/status-page`, payload: {} },
    {
      name: 'export project',
      method: 'POST',
      url: `${base}/export`,
      payload: { passphrase: 'a-long-export-passphrase-1' },
    },
  ]
}

async function auditRowCount(orgId: string): Promise<number> {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select({ n: count() }).from(auditLogEntries).where(eq(auditLogEntries.orgId, orgId))
  )
  return Number(row?.n ?? 0)
}

async function memberWithProjectRole(label: string, orgRole: string, projectRole?: string) {
  const user = await addUserToOrg(app, owner.orgId, label, { orgRole })
  if (projectRole) await addProjectMember(owner.orgId, projectId, user.userId, projectRole)
  return user
}

beforeAll(async () => {
  app = await bootCredentialRouteApp(createApp, initVault, PASSPHRASE)
  owner = await registerOwner(app, 'owner')
  projectId = await createProjectViaApi(app, owner.cookies, 'viewer-ro')
  const created = await inject(owner.cookies, {
    name: 'seed secret',
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    payload: { name: 'Seed', value: 'seed-value' },
  })
  expect(created.statusCode).toBe(201)
  credentialId = created.json<{ data: { id: string } }>().data.id
  const endpoint = await inject(owner.cookies, {
    name: 'seed endpoint',
    method: 'POST',
    url: `/api/v1/projects/${projectId}/service-endpoints`,
    payload: { name: 'Seed', url: 'https://seed.example.com/health' },
  })
  expect(endpoint.statusCode).toBe(201)
  endpointId = endpoint.json<{ data: { id: string } }>().data.id
})

afterAll(async () => {
  await app.close()
  await resetVaultForTest()
})

describe('Story 69.17 — project viewers are read-only', () => {
  it('refuses every project write for a project viewer with org role member, writes nothing and audits nothing', async () => {
    const viewer = await memberWithProjectRole('viewer', 'member', 'viewer')
    const auditBefore = await auditRowCount(owner.orgId)

    for (const write of projectWrites()) {
      const res = await inject(viewer.cookies, write)
      expect({ write: write.name, status: res.statusCode, body: res.json() }).toEqual({
        write: write.name,
        status: 403,
        body: PROJECT_ROLE_DENIED,
      })
    }

    expect(await auditRowCount(owner.orgId)).toBe(auditBefore)
    const [endpoint] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(serviceEndpoints).where(eq(serviceEndpoints.id, endpointId))
    )
    expect(endpoint?.healthCheckPausedAt).toBeNull()
  })

  it('still lets the project viewer read what is there', async () => {
    const viewer = await memberWithProjectRole('viewer-reads', 'member', 'viewer')
    for (const path of ['credentials', 'service-endpoints', `credentials/${credentialId}`]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/${path}`,
        headers: { cookie: cookieHeader(viewer.cookies) },
      })
      expect({ path, status: res.statusCode }).toEqual({ path, status: 200 })
    }
  })

  it('keeps data a member wrote after that member is demoted to viewer (no back-compat loss)', async () => {
    const demoted = await memberWithProjectRole('demoted', 'member', 'member')
    const created = await inject(demoted.cookies, projectWrites()[0] as Write)
    expect(created.statusCode).toBe(201)
    const id = created.json<{ data: { id: string } }>().data.id
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(projectMemberships)
        .set({ role: 'viewer' })
        .where(
          and(
            eq(projectMemberships.userId, demoted.userId),
            eq(projectMemberships.projectId, projectId)
          )
        )
    )

    const edit = await inject(demoted.cookies, {
      name: 'edit own secret',
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/credentials/${id}`,
      payload: { description: 'after demotion' },
    })
    expect(edit.statusCode).toBe(403)
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/credentials/${id}`,
      headers: { cookie: cookieHeader(demoted.cookies) },
    })
    expect(read.statusCode).toBe(200)
    const [row] = await withOrg(owner.orgId, (tx) =>
      tx.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, id))
    )
    expect(row?.id).toBe(id)
  })

  it.each([
    ['a project member', 'member', 'member'],
    ['a project admin', 'member', 'admin'],
    ['an org admin holding a viewer row (org bypass)', 'admin', 'viewer'],
  ] as const)('lets %s write', async (_label, orgRole, projectRole) => {
    const user = await memberWithProjectRole(
      `writer-${orgRole}-${projectRole ?? 'none'}`,
      orgRole,
      projectRole
    )
    const res = await inject(user.cookies, projectWrites()[0] as Write)
    expect(res.statusCode).toBe(201)
  })

  it('sends an org member with no row to the handler (its visibility 404), not to a 403', async () => {
    const user = await memberWithProjectRole('no-row', 'member')
    const res = await inject(user.cookies, projectWrites()[0] as Write)
    expect(res.statusCode).toBe(404)
  })

  it('lets the org owner write', async () => {
    const res = await inject(owner.cookies, projectWrites()[0] as Write)
    expect(res.statusCode).toBe(201)
  })

  it('keeps the org-role floor: an org viewer is refused by org role even with a project member row', async () => {
    const user = await memberWithProjectRole('org-viewer', 'viewer', 'member')
    const res = await inject(user.cookies, projectWrites()[0] as Write)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'insufficient_role' })
  })

  it('a platform operator gets no project-role bypass', async () => {
    const operator = await registerPlatformOperator(app, {
      emailPrefix: `viewer-ro-op-${randomUUID()}`,
      orgNamePrefix: 'Viewer RO Operator',
      password: 'correct-horse-battery-staple',
    })
    await withOrg(owner.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: owner.orgId, userId: operator.userId, role: 'member' })
    )
    await addProjectMember(owner.orgId, projectId, operator.userId, 'viewer')
    const cookies = await mintOrgSessionCookies(app, operator.userId, owner.orgId)

    const res = await inject(cookies, projectWrites()[0] as Write)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual(PROJECT_ROLE_DENIED)
  })

  it('answers a foreign or missing project with the same 404 as before (no project-role oracle)', async () => {
    const viewer = await memberWithProjectRole('viewer-404', 'member', 'viewer')
    const otherOwner = await registerOwner(app, 'other-owner')
    const foreignProjectId = await createProjectViaApi(app, otherOwner.cookies, 'viewer-ro-foreign')

    for (const target of [foreignProjectId, randomUUID()]) {
      const res = await inject(viewer.cookies, {
        name: 'create secret elsewhere',
        method: 'POST',
        url: `/api/v1/projects/${target}/credentials`,
        payload: { name: 'x', value: 'y' },
      })
      expect(res.statusCode).toBe(404)
    }
  })
})
