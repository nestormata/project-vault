import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const FORCED_AUDIT_FAILURE = 'forced audit failure'
const MACHINE_USER_NAME = 'ci-deploy-bot'
const MACHINE_USER_DEACTIVATED_EVENT = 'machine_user.deactivated'

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'machine-user-deactivation',
  orgNamePrefix: 'Machine User Deactivation',
})

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function machineUserUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}`
}
function deactivateUrl(machineUserId: string): string {
  return `${machineUserUrl(machineUserId)}/deactivate`
}
function apiKeysUrl(machineUserId: string): string {
  return `${machineUserUrl(machineUserId)}/api-keys`
}

type MachineUserDetailBody = {
  data: { id: string; deactivatedAt: string | null }
}

function createMachineUser(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  body: Record<string, unknown> = { name: MACHINE_USER_NAME, role: 'member' }
) {
  return app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function createMachineUserOrThrow(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<MachineUserDetailBody['data']> {
  const res = await createMachineUser(app, cookies, projectId)
  expect(res.statusCode).toBe(201)
  return res.json<MachineUserDetailBody>().data
}

function deactivateMachineUser(
  app: TestApp,
  cookies: Record<string, string>,
  machineUserId: string
) {
  return app.inject({
    method: 'POST',
    url: deactivateUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

function issueApiKey(app: TestApp, cookies: Record<string, string>, machineUserId: string) {
  return app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'post-deactivation-key' },
  })
}

async function auditRowsFor(orgId: string, eventType: string) {
  const { auditLogEntries } = await import('@project-vault/db/schema')
  return withOrg(orgId, (tx) =>
    tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, eventType))
  )
}

describe.sequential('POST /machine-users/:machineUserId/deactivate (8-6 AC-5)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('sets deactivatedAt, returns 200, and writes a machine_user.deactivated audit event', async () => {
    const owner = await registerOwner(app, 'deactivate-happy')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-happy')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

    const res = await deactivateMachineUser(app, owner.cookies, machineUser.id)
    expect(res.statusCode).toBe(200)
    const body = res.json<MachineUserDetailBody>()
    expect(body.data.id).toBe(machineUser.id)
    expect(body.data.deactivatedAt).not.toBeNull()

    const detail = await app.inject({
      method: 'GET',
      url: machineUserUrl(machineUser.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(detail.json<MachineUserDetailBody>().data.deactivatedAt).toBe(body.data.deactivatedAt)

    const auditRows = await auditRowsFor(owner.orgId, MACHINE_USER_DEACTIVATED_EVENT)
    expect(auditRows.filter((row) => row.resourceId === machineUser.id)).toHaveLength(1)
  })

  it('is idempotent: a second deactivate call still returns 200 with the same timestamp and does not double-audit', async () => {
    const owner = await registerOwner(app, 'deactivate-idempotent')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-idempotent')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

    const first = await deactivateMachineUser(app, owner.cookies, machineUser.id)
    expect(first.statusCode).toBe(200)
    const firstDeactivatedAt = first.json<MachineUserDetailBody>().data.deactivatedAt

    const second = await deactivateMachineUser(app, owner.cookies, machineUser.id)
    expect(second.statusCode).toBe(200)
    expect(second.json<MachineUserDetailBody>().data.deactivatedAt).toBe(firstDeactivatedAt)

    const auditRows = await auditRowsFor(owner.orgId, MACHINE_USER_DEACTIVATED_EVENT)
    expect(auditRows.filter((row) => row.resourceId === machineUser.id)).toHaveLength(1)
  })

  it('rejects new key issuance against a deactivated machine user with 409 machine_user_deactivated', async () => {
    const owner = await registerOwner(app, 'deactivate-key-issuance')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-key-issuance')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

    const deactivate = await deactivateMachineUser(app, owner.cookies, machineUser.id)
    expect(deactivate.statusCode).toBe(200)

    const issued = await issueApiKey(app, owner.cookies, machineUser.id)
    expect(issued.statusCode).toBe(409)
    expect(issued.json()).toMatchObject({ code: 'machine_user_deactivated' })

    const keys = await withOrg(owner.orgId, (tx) =>
      tx.select().from(apiKeys).where(eq(apiKeys.machineUserId, machineUser.id))
    )
    expect(keys).toHaveLength(0)
  })

  it('an existing key on a deactivated machine user remains individually revocable', async () => {
    const owner = await registerOwner(app, 'deactivate-still-revocable')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-still-revocable')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
    const issueRes = await issueApiKey(app, owner.cookies, machineUser.id)
    expect(issueRes.statusCode).toBe(201)
    const keyId = issueRes.json<{ data: { id: string } }>().data.id

    const deactivate = await deactivateMachineUser(app, owner.cookies, machineUser.id)
    expect(deactivate.statusCode).toBe(200)

    const revoke = await app.inject({
      method: 'DELETE',
      url: `${apiKeysUrl(machineUser.id)}/${keyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(revoke.statusCode).toBe(200)
  })

  it('404 on a nonexistent or cross-org machine user', async () => {
    const owner = await registerOwner(app, 'deactivate-notfound')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-notfound')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

    const missing = await deactivateMachineUser(app, owner.cookies, randomUUID())
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'machine_user_not_found' })

    const otherOwner = await registerOwner(app, 'deactivate-notfound-other')
    const crossOrg = await deactivateMachineUser(app, otherOwner.cookies, machineUser.id)
    expect(crossOrg.statusCode).toBe(404)
  })

  it('403 insufficient_role for a non-admin org member', async () => {
    const owner = await registerOwner(app, 'deactivate-authz')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-authz')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
    const { addUserToOrg } = createMembershipTestHelpers({
      emailPrefix: 'machine-user-deactivation-member',
      orgNamePrefix: 'Machine User Deactivation Member',
    })
    const member = await addUserToOrg(app, owner.orgId, 'deactivate-authz-member', {
      orgRole: 'member',
    })

    const res = await deactivateMachineUser(app, member.cookies, machineUser.id)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'insufficient_role' })
  })

  it('rolls back and returns 503 audit_write_failed when the audit write fails (fail-closed)', async () => {
    const owner = await registerOwner(app, 'deactivate-audit-fail')
    const projectId = await createProjectViaApi(app, owner.cookies, 'deactivate-audit-fail')
    const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const res = await deactivateMachineUser(app, owner.cookies, machineUser.id)
      expectAuditWriteFailed(res)

      const detail = await app.inject({
        method: 'GET',
        url: machineUserUrl(machineUser.id),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(detail.json<MachineUserDetailBody>().data.deactivatedAt).toBeNull()
    } finally {
      auditSpy.mockRestore()
    }
  })
})
