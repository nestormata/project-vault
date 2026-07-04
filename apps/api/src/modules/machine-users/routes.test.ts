import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, machineUsers, orgMemberships } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
  expectAuditWriteFailed,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const FORCED_AUDIT_FAILURE = 'forced audit failure'
const MACHINE_USER_NAME = 'ci-deploy-bot'
const PASSWORD = 'correct-horse-battery-staple'
const PROD_DEPLOY_KEY_NAME = 'prod-deploy-key'
const AUDIT_WRITE_FAILED_TITLE =
  'rolls back and returns 503 audit_write_failed when the audit write fails (AC-15)'
const MACHINE_USER_API_KEY_REVOKED = 'machine_user.api_key_revoked'

const { registerOwner, addUserToOrg } = createMembershipTestHelpers({
  emailPrefix: 'machine-users',
  orgNamePrefix: 'Machine Users',
})

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function machineUserUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}`
}
function apiKeysUrl(machineUserId: string): string {
  return `${machineUserUrl(machineUserId)}/api-keys`
}
function apiKeyUrl(machineUserId: string, keyId: string): string {
  return `${apiKeysUrl(machineUserId)}/${keyId}`
}

type MachineUserDetailBody = {
  data: {
    id: string
    projectId: string
    name: string
    description: string | null
    role: string
    createdBy: string
    createdAt: string
    deactivatedAt: string | null
    scopeBoundary: { canAccess: string[]; cannotAccess: string[] }
  }
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
  projectId: string,
  body: Record<string, unknown> = { name: MACHINE_USER_NAME, role: 'member' }
): Promise<MachineUserDetailBody['data']> {
  const res = await createMachineUser(app, cookies, projectId, body)
  expect(res.statusCode).toBe(201)
  return res.json<MachineUserDetailBody>().data
}

type ApiKeyIssuedBody = {
  data: {
    id: string
    machineUserId: string
    name: string
    key: string
    expiresAt: string | null
    createdAt: string
  }
}

function issueApiKey(
  app: TestApp,
  cookies: Record<string, string>,
  machineUserId: string,
  body: Record<string, unknown> = { name: PROD_DEPLOY_KEY_NAME }
) {
  return app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function issueApiKeyOrThrow(
  app: TestApp,
  cookies: Record<string, string>,
  machineUserId: string,
  body: Record<string, unknown> = { name: PROD_DEPLOY_KEY_NAME }
): Promise<ApiKeyIssuedBody['data']> {
  const res = await issueApiKey(app, cookies, machineUserId, body)
  expect(res.statusCode).toBe(201)
  return res.json<ApiKeyIssuedBody>().data
}

function revokeApiKey(
  app: TestApp,
  cookies: Record<string, string>,
  machineUserId: string,
  keyId: string
) {
  return app.inject({
    method: 'DELETE',
    url: apiKeyUrl(machineUserId, keyId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function expireMfaGracePeriod(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .update(orgMemberships)
      .set({ gracePeriodExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  )
}

async function auditRowsFor(orgId: string, eventType: string) {
  const { auditLogEntries } = await import('@project-vault/db/schema')
  return withOrg(orgId, (tx) =>
    tx.select().from(auditLogEntries).where(eq(auditLogEntries.eventType, eventType))
  )
}

describe.sequential('machine-user routes (7.1)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('POST /projects/:projectId/machine-users', () => {
    it('creates a machine user with a scope-boundary block before any key exists (AC-3)', async () => {
      const owner = await registerOwner(app, 'create-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'create-happy')

      const res = await createMachineUser(app, owner.cookies, projectId, {
        name: MACHINE_USER_NAME,
        role: 'member',
        description: 'GitHub Actions deploy pipeline',
      })

      expect(res.statusCode).toBe(201)
      const body = res.json<MachineUserDetailBody>()
      expect(body.data).toMatchObject({
        projectId,
        name: MACHINE_USER_NAME,
        description: 'GitHub Actions deploy pipeline',
        role: 'member',
        createdBy: owner.userId,
        deactivatedAt: null,
      })
      expect(body.data.scopeBoundary.canAccess.length).toBeGreaterThan(0)
      expect(body.data.scopeBoundary.cannotAccess).toEqual(
        expect.arrayContaining(['other projects', 'org settings', 'audit logs'])
      )

      const auditRows = await auditRowsFor(owner.orgId, 'machine_user.created')
      expect(auditRows.some((row) => row.resourceId === body.data.id)).toBe(true)
      const matchingRow = auditRows.find((row) => row.resourceId === body.data.id)
      expect(matchingRow?.payload).toMatchObject({ name: MACHINE_USER_NAME, role: 'member' })
    })

    it('422 on invalid role/name/description (AC-4)', async () => {
      const owner = await registerOwner(app, 'create-validation')
      const projectId = await createProjectViaApi(app, owner.cookies, 'create-validation')

      const cases: Record<string, unknown>[] = [
        { name: MACHINE_USER_NAME, role: 'admin' },
        { name: MACHINE_USER_NAME, role: 'owner' },
        { name: MACHINE_USER_NAME, role: 'not-a-role' },
        { name: '', role: 'member' },
        { role: 'member' },
        { name: 'x'.repeat(129), role: 'member' },
        { name: MACHINE_USER_NAME, role: 'member', description: 'x'.repeat(1025) },
      ]

      for (const body of cases) {
        const res = await createMachineUser(app, owner.cookies, projectId, body)
        expect(res.statusCode).toBe(422)
        expect(res.json()).toMatchObject({ code: 'validation_error' })
      }

      const list = await app.inject({
        method: 'GET',
        url: machineUsersUrl(projectId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(list.json<{ data: { total: number } }>().data.total).toBe(0)
    })

    it('allows a duplicate name within the same project (AC-4)', async () => {
      const owner = await registerOwner(app, 'create-dup-name')
      const projectId = await createProjectViaApi(app, owner.cookies, 'create-dup-name')

      const first = await createMachineUser(app, owner.cookies, projectId)
      const second = await createMachineUser(app, owner.cookies, projectId)
      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
    })

    it('403 insufficient_role for a non-admin org member (AC-5)', async () => {
      const owner = await registerOwner(app, 'create-authz-role')
      const projectId = await createProjectViaApi(app, owner.cookies, 'create-authz-role')
      const member = await addUserToOrg(app, owner.orgId, 'create-authz-role-member', {
        orgRole: 'member',
      })

      const res = await createMachineUser(app, member.cookies, projectId)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('403 mfa_required when an admin has no MFA enrollment and no active grace period (AC-5)', async () => {
      const unenrolled = await registerAndLoginViaApi(app, {
        email: `machine-users-mfa-${randomUUID()}@example.com`,
        password: PASSWORD,
        orgName: `Machine Users MFA ${randomUUID()}`,
      })
      const projectId = await createProjectViaApi(app, unenrolled.cookies, 'create-authz-mfa')
      await expireMfaGracePeriod(unenrolled.orgId, unenrolled.userId)

      const res = await createMachineUser(app, unenrolled.cookies, projectId)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'mfa_required' })
    })

    it('succeeds within an active MFA grace period (AC-5)', async () => {
      const graceOwner = await registerAndLoginViaApi(app, {
        email: `machine-users-grace-${randomUUID()}@example.com`,
        password: PASSWORD,
        orgName: `Machine Users Grace ${randomUUID()}`,
      })
      const projectId = await createProjectViaApi(app, graceOwner.cookies, 'create-authz-grace')

      const res = await createMachineUser(app, graceOwner.cookies, projectId)
      expect(res.statusCode).toBe(201)
    })

    it('404 (never 403) on cross-org or nonexistent project (AC-6)', async () => {
      const owner = await registerOwner(app, 'create-tenant-owner')
      const otherOwner = await registerOwner(app, 'create-tenant-other')
      const otherProjectId = await createProjectViaApi(
        app,
        otherOwner.cookies,
        'create-tenant-other'
      )

      const crossOrg = await createMachineUser(app, owner.cookies, otherProjectId)
      expect(crossOrg.statusCode).toBe(404)
      expect(crossOrg.json()).toMatchObject({ code: 'project_not_found' })

      const missing = await createMachineUser(app, owner.cookies, randomUUID())
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ code: 'project_not_found' })
    })

    it(AUDIT_WRITE_FAILED_TITLE, async () => {
      const owner = await registerOwner(app, 'create-audit-fail')
      const projectId = await createProjectViaApi(app, owner.cookies, 'create-audit-fail')

      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
      try {
        const res = await createMachineUser(app, owner.cookies, projectId)
        expectAuditWriteFailed(res)

        const list = await app.inject({
          method: 'GET',
          url: machineUsersUrl(projectId),
          headers: { cookie: cookieHeader(owner.cookies) },
        })
        expect(list.json<{ data: { total: number } }>().data.total).toBe(0)
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('GET /projects/:projectId/machine-users', () => {
    it('lists machine users, empty array when none, 404 cross-org (AC-7)', async () => {
      const owner = await registerOwner(app, 'list-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'list-happy')

      const empty = await app.inject({
        method: 'GET',
        url: machineUsersUrl(projectId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(empty.statusCode).toBe(200)
      expect(empty.json()).toMatchObject({ data: { items: [], total: 0 } })

      await createMachineUserOrThrow(app, owner.cookies, projectId)

      const populated = await app.inject({
        method: 'GET',
        url: machineUsersUrl(projectId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(populated.statusCode).toBe(200)
      const body = populated.json<{ data: { items: { name: string }[]; total: number } }>()
      expect(body.data.total).toBe(1)
      expect(body.data.items[0]).not.toHaveProperty('scopeBoundary')

      const otherOwner = await registerOwner(app, 'list-other-owner')
      const crossOrg = await app.inject({
        method: 'GET',
        url: machineUsersUrl(projectId),
        headers: { cookie: cookieHeader(otherOwner.cookies) },
      })
      expect(crossOrg.statusCode).toBe(404)
    })
  })

  describe('GET /machine-users/:machineUserId', () => {
    it('returns machine-user detail with scopeBoundary; 404 cross-org/nonexistent (AC-8)', async () => {
      const owner = await registerOwner(app, 'detail-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'detail-happy')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const res = await app.inject({
        method: 'GET',
        url: machineUserUrl(machineUser.id),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<MachineUserDetailBody>().data.scopeBoundary).toBeDefined()

      const otherOwner = await registerOwner(app, 'detail-other-owner')
      const crossOrg = await app.inject({
        method: 'GET',
        url: machineUserUrl(machineUser.id),
        headers: { cookie: cookieHeader(otherOwner.cookies) },
      })
      expect(crossOrg.statusCode).toBe(404)
      expect(crossOrg.json()).toMatchObject({ code: 'machine_user_not_found' })

      const missing = await app.inject({
        method: 'GET',
        url: machineUserUrl(randomUUID()),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(missing.statusCode).toBe(404)
    })
  })

  describe('POST /machine-users/:machineUserId/api-keys', () => {
    it('issues a key, returns plaintext once, and persists only the hash (AC-9)', async () => {
      const owner = await registerOwner(app, 'issue-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'issue-happy')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const res = await issueApiKey(app, owner.cookies, machineUser.id, {
        name: PROD_DEPLOY_KEY_NAME,
        expiresAt: '2027-01-01T00:00:00.000Z',
      })
      expect(res.statusCode).toBe(201)
      const body = res.json<ApiKeyIssuedBody>()
      expect(body.data.key.startsWith('pk_')).toBe(true)
      expect(body.data.machineUserId).toBe(machineUser.id)

      const [storedKey] = await withOrg(owner.orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, body.data.id))
      )
      expect(storedKey?.keyHash).not.toBe(body.data.key)
      expect(storedKey?.keyHash).toMatch(/^[0-9a-f]{64}$/)
      expect(storedKey?.hmacKeyVersion).toBe(1)

      const auditRows = await auditRowsFor(owner.orgId, 'machine_user.api_key_issued')
      const matchingRow = auditRows.find((row) => row.resourceId === body.data.id)
      expect(matchingRow).toBeDefined()
      expect(JSON.stringify(matchingRow?.payload)).not.toContain(body.data.key)
    })

    it('422 on a past expiresAt; null expiresAt when omitted; 422 on invalid date/name (AC-10)', async () => {
      const owner = await registerOwner(app, 'issue-validation')
      const projectId = await createProjectViaApi(app, owner.cookies, 'issue-validation')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const past = await issueApiKey(app, owner.cookies, machineUser.id, {
        name: 'past-key',
        expiresAt: '2020-01-01T00:00:00.000Z',
      })
      expect(past.statusCode).toBe(422)

      const invalidDate = await issueApiKey(app, owner.cookies, machineUser.id, {
        name: 'invalid-date-key',
        expiresAt: 'not-a-date',
      })
      expect(invalidDate.statusCode).toBe(422)

      const noExpiry = await issueApiKey(app, owner.cookies, machineUser.id, {
        name: 'no-expiry-key',
      })
      expect(noExpiry.statusCode).toBe(201)
      expect(noExpiry.json<ApiKeyIssuedBody>().data.expiresAt).toBeNull()

      for (const name of ['', 'x'.repeat(129)]) {
        const res = await issueApiKey(app, owner.cookies, machineUser.id, { name })
        expect(res.statusCode).toBe(422)
      }
      const omittedName = await issueApiKey(app, owner.cookies, machineUser.id, {})
      expect(omittedName.statusCode).toBe(422)
    })

    it('404 on nonexistent/cross-org machine user; 409 on a deactivated one (AC-11)', async () => {
      const owner = await registerOwner(app, 'issue-notfound')
      const projectId = await createProjectViaApi(app, owner.cookies, 'issue-notfound')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const missing = await issueApiKey(app, owner.cookies, randomUUID())
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ code: 'machine_user_not_found' })

      const otherOwner = await registerOwner(app, 'issue-notfound-other')
      const crossOrg = await issueApiKey(app, otherOwner.cookies, machineUser.id)
      expect(crossOrg.statusCode).toBe(404)

      // AC-11 test note: no endpoint in this story sets deactivatedAt — fixture it directly.
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(machineUsers)
          .set({ deactivatedAt: new Date() })
          .where(eq(machineUsers.id, machineUser.id))
      )
      const deactivated = await issueApiKey(app, owner.cookies, machineUser.id)
      expect(deactivated.statusCode).toBe(409)
      expect(deactivated.json()).toMatchObject({ code: 'machine_user_deactivated' })
    })

    it(AUDIT_WRITE_FAILED_TITLE, async () => {
      const owner = await registerOwner(app, 'issue-audit-fail')
      const projectId = await createProjectViaApi(app, owner.cookies, 'issue-audit-fail')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
      try {
        const res = await issueApiKey(app, owner.cookies, machineUser.id)
        expectAuditWriteFailed(res)

        const keys = await withOrg(owner.orgId, (tx) =>
          tx.select().from(apiKeys).where(eq(apiKeys.machineUserId, machineUser.id))
        )
        expect(keys).toHaveLength(0)
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('GET /machine-users/:machineUserId/api-keys', () => {
    it('lists key metadata only — never keyHash/plaintext (AC-12)', async () => {
      const owner = await registerOwner(app, 'list-keys')
      const projectId = await createProjectViaApi(app, owner.cookies, 'list-keys')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
      const active = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id, {
        name: 'active-key',
      })
      const toRevoke = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id, {
        name: 'old-key',
      })
      await revokeApiKey(app, owner.cookies, machineUser.id, toRevoke.id)

      const res = await app.inject({
        method: 'GET',
        url: apiKeysUrl(machineUser.id),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ data: { items: Record<string, unknown>[]; total: number } }>()
      expect(JSON.stringify(body)).not.toContain(active.key)
      expect(body.data.total).toBe(2)
      for (const item of body.data.items) {
        expect(item).not.toHaveProperty('keyHash')
        expect(item).not.toHaveProperty('key')
      }
      const activeItem = body.data.items.find((item) => item['id'] === active.id)
      const revokedItem = body.data.items.find((item) => item['id'] === toRevoke.id)
      expect(activeItem).toMatchObject({ isRevoked: false })
      expect(revokedItem).toMatchObject({ isRevoked: true })
    })
  })

  describe('DELETE /machine-users/:machineUserId/api-keys/:keyId', () => {
    it('revokes a key and is idempotent on a second call (AC-13)', async () => {
      const owner = await registerOwner(app, 'revoke-happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'revoke-happy')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
      const key = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id)

      const first = await revokeApiKey(app, owner.cookies, machineUser.id, key.id)
      expect(first.statusCode).toBe(200)
      const firstRevokedAt = first.json<{ data: { id: string; revokedAt: string } }>().data
        .revokedAt

      const second = await revokeApiKey(app, owner.cookies, machineUser.id, key.id)
      expect(second.statusCode).toBe(200)
      expect(second.json<{ data: { revokedAt: string } }>().data.revokedAt).toBe(firstRevokedAt)

      const auditRows = await auditRowsFor(owner.orgId, MACHINE_USER_API_KEY_REVOKED)
      expect(auditRows.filter((row) => row.resourceId === key.id)).toHaveLength(1)

      const list = await app.inject({
        method: 'GET',
        url: apiKeysUrl(machineUser.id),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      const item = list
        .json<{ data: { items: { id: string; isRevoked: boolean }[] } }>()
        .data.items.find((entry) => entry.id === key.id)
      expect(item?.isRevoked).toBe(true)
    })

    it('404 on a nonexistent or cross-org key', async () => {
      const owner = await registerOwner(app, 'revoke-notfound')
      const projectId = await createProjectViaApi(app, owner.cookies, 'revoke-notfound')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const missing = await revokeApiKey(app, owner.cookies, machineUser.id, randomUUID())
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toMatchObject({ code: 'api_key_not_found' })

      const otherOwner = await registerOwner(app, 'revoke-notfound-other')
      const key = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id)
      const crossOrg = await revokeApiKey(app, otherOwner.cookies, machineUser.id, key.id)
      expect(crossOrg.statusCode).toBe(404)
    })

    it(AUDIT_WRITE_FAILED_TITLE, async () => {
      const owner = await registerOwner(app, 'revoke-audit-fail')
      const projectId = await createProjectViaApi(app, owner.cookies, 'revoke-audit-fail')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
      const key = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id)

      const auditSpy = vi
        .spyOn(humanAudit, 'writeHumanAuditEntry')
        .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
      try {
        const res = await revokeApiKey(app, owner.cookies, machineUser.id, key.id)
        expectAuditWriteFailed(res)

        const [row] = await withOrg(owner.orgId, (tx) =>
          tx.select().from(apiKeys).where(eq(apiKeys.id, key.id))
        )
        expect(row?.revokedAt).toBeNull()
      } finally {
        auditSpy.mockRestore()
      }
    })

    it('concurrent revokes both return 200, set revokedAt exactly once, and audit exactly once (AC-17)', async () => {
      const owner = await registerOwner(app, 'revoke-concurrent')
      const projectId = await createProjectViaApi(app, owner.cookies, 'revoke-concurrent')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
      const key = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id)

      const [first, second] = await Promise.all([
        revokeApiKey(app, owner.cookies, machineUser.id, key.id),
        revokeApiKey(app, owner.cookies, machineUser.id, key.id),
      ])
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(first.json<{ data: { revokedAt: string } }>().data.revokedAt).toBe(
        second.json<{ data: { revokedAt: string } }>().data.revokedAt
      )

      const auditRows = await auditRowsFor(owner.orgId, MACHINE_USER_API_KEY_REVOKED)
      expect(auditRows.filter((row) => row.resourceId === key.id)).toHaveLength(1)
    })
  })

  describe('AC-17: concurrent key issuance', () => {
    it('both concurrent issue-key calls succeed with distinct keys', async () => {
      const owner = await registerOwner(app, 'issue-concurrent')
      const projectId = await createProjectViaApi(app, owner.cookies, 'issue-concurrent')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)

      const [first, second] = await Promise.all([
        issueApiKey(app, owner.cookies, machineUser.id, { name: 'concurrent-key-a' }),
        issueApiKey(app, owner.cookies, machineUser.id, { name: 'concurrent-key-b' }),
      ])
      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
      const firstKey = first.json<ApiKeyIssuedBody>().data
      const secondKey = second.json<ApiKeyIssuedBody>().data
      expect(firstKey.id).not.toBe(secondKey.id)
      expect(firstKey.key).not.toBe(secondKey.key)
    })
  })

  describe('AC-15: audit payload never contains secret material', () => {
    it('create/issue/revoke audit payloads never include key/apiKey/keyHash/plaintext/value', async () => {
      const owner = await registerOwner(app, 'audit-sanitization')
      const projectId = await createProjectViaApi(app, owner.cookies, 'audit-sanitization')
      const machineUser = await createMachineUserOrThrow(app, owner.cookies, projectId)
      const key = await issueApiKeyOrThrow(app, owner.cookies, machineUser.id)
      await revokeApiKey(app, owner.cookies, machineUser.id, key.id)

      const eventTypes = [
        'machine_user.created',
        'machine_user.api_key_issued',
        MACHINE_USER_API_KEY_REVOKED,
      ]
      for (const eventType of eventTypes) {
        const rows = await auditRowsFor(owner.orgId, eventType)
        for (const row of rows) {
          const serialized = JSON.stringify(row.payload).toLowerCase()
          expect(serialized).not.toContain('keyhash')
          expect(serialized).not.toContain('plaintext')
          expect(serialized.includes('"key"')).toBe(false)
          expect(serialized.includes('"apikey"')).toBe(false)
          expect(serialized.includes('"value"')).toBe(false)
        }
      }
    })
  })

  describe('AC-16: rate limiting on sensitive mutations', () => {
    it('returns 429 on the 11th create-machine-user request within 60s (shared per-admin-per-route)', async () => {
      process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
      try {
        const owner = await registerOwner(app, 'rate-limit-create')
        const projectA = await createProjectViaApi(app, owner.cookies, 'rate-limit-create-a')
        const projectB = await createProjectViaApi(app, owner.cookies, 'rate-limit-create-b')

        const responses = []
        for (let i = 0; i < 11; i += 1) {
          const projectId = i % 2 === 0 ? projectA : projectB
          responses.push(
            await createMachineUser(app, owner.cookies, projectId, {
              name: `rate-limit-bot-${i}`,
              role: 'member',
            })
          )
        }
        const last = responses.at(-1)
        expect(last?.statusCode).toBe(429)
        expect(last?.json()).toMatchObject({ code: 'rate_limit_exceeded' })
        // First 10 across both projects succeeded — confirms the budget is shared per-admin
        // per-route, not per-machine-user/per-project.
        expect(responses.slice(0, 10).every((res) => res.statusCode === 201)).toBe(true)
      } finally {
        delete process.env['RATE_LIMIT_TEST_ENFORCE']
      }
    }, 30_000)
  })
})
