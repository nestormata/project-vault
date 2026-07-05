import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, auditLogEntries } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
const machineAuditModule = await import('../audit/machine-entry.js')
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'machine-credential',
  orgNamePrefix: 'Machine Credential',
})

const FORCED_AUDIT_FAILURE = 'forced machine audit failure'

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}
function machineCredentialValueUrl(projectId: string, name: string): string {
  return `/api/v1/machine/projects/${projectId}/credentials/${encodeURIComponent(name)}/value`
}

async function issueMachineUserAndKey(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  role: 'member' | 'viewer' = 'member'
): Promise<{ machineUserId: string; key: string }> {
  const muRes = await app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `bot-${randomUUID().slice(0, 8)}`, role },
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

async function createCredentialViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  name: string,
  value: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { name, value },
  })
  expect(res.statusCode).toBe(201)
  return res.json<{ data: { id: string } }>().data.id
}

describe('GET /api/v1/machine/projects/:projectId/credentials/:name/value', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  describe('AC-6: happy path', () => {
    it('returns the current version value with name/versionNumber/cacheable', async () => {
      const owner = await registerOwner(app, 'happy')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-happy')
      await createCredentialViaApi(app, owner.cookies, projectId, 'DATABASE_URL', 'postgres://v1')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'DATABASE_URL'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: {
          name: 'DATABASE_URL',
          value: 'postgres://v1',
          versionNumber: 1,
          cacheable: true,
        },
      })
    })

    it('handles a credential name containing a slash', async () => {
      const owner = await registerOwner(app, 'slash-name')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-slash')
      await createCredentialViaApi(app, owner.cookies, projectId, 'api/key', 'slashy-value')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'api/key'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { name: string; value: string } }>().data).toMatchObject({
        name: 'api/key',
        value: 'slashy-value',
      })
    })
  })

  describe('AC-7: not found, ambiguous, cross-project isolation', () => {
    it('returns 404 credential_not_found for a name that does not exist', async () => {
      const owner = await registerOwner(app, 'not-found')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-notfound')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'NOPE'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'credential_not_found' })
    })

    it('returns 409 ambiguous_credential_name with matchCount when two credentials share a name', async () => {
      const owner = await registerOwner(app, 'ambiguous')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-ambiguous')
      await createCredentialViaApi(app, owner.cookies, projectId, 'API_KEY', 'v1')
      await createCredentialViaApi(app, owner.cookies, projectId, 'API_KEY', 'v2')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'API_KEY'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'ambiguous_credential_name', matchCount: 2 })
    })

    it('returns 403 insufficient_role when the JWT scope does not match the URL projectId', async () => {
      const owner = await registerOwner(app, 'cross-project')
      const projectA = await createProjectViaApi(app, owner.cookies, 'machine-cred-a')
      const projectB = await createProjectViaApi(app, owner.cookies, 'machine-cred-b')
      await createCredentialViaApi(app, owner.cookies, projectB, 'SHARED_NAME', 'b-value')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectA)
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectB, 'SHARED_NAME'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    })

    it('returns 404 for a credential belonging to a different project in the same org', async () => {
      const owner = await registerOwner(app, 'diff-project-same-org')
      const projectA = await createProjectViaApi(app, owner.cookies, 'machine-cred-diffa')
      const projectB = await createProjectViaApi(app, owner.cookies, 'machine-cred-diffb')
      await createCredentialViaApi(app, owner.cookies, projectB, 'ONLY_IN_B', 'b-value')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectA)
      const jwt = await exchangeForMachineJwt(app, key)

      // Request via the caller's OWN scoped project (projectA), not projectB — the JWT scope
      // matches the URL, so this reaches the 404 path (query scoped by AND project_id), not 403.
      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectA, 'ONLY_IN_B'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'credential_not_found' })
    })
  })

  describe('AC-8: role authorization and revoked-mid-request handling', () => {
    it('succeeds for a machine user with role viewer (deliberate departure from human viewer)', async () => {
      const owner = await registerOwner(app, 'viewer-role')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-viewer')
      await createCredentialViaApi(app, owner.cookies, projectId, 'VIEWER_SECRET', 'viewer-value')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId, 'viewer')
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'VIEWER_SECRET'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(200)
    })

    it('returns 401 invalid_machine_token when the key is revoked after JWT issuance', async () => {
      const owner = await registerOwner(app, 'revoked-mid')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-revokedmid')
      await createCredentialViaApi(app, owner.cookies, projectId, 'REVOKED_MID', 'value')
      const { machineUserId, key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const listRes = await app.inject({
        method: 'GET',
        url: apiKeysUrl(machineUserId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      const keyId = listRes.json<{ data: { items: { id: string }[] } }>().data.items[0]?.id
      await app.inject({
        method: 'DELETE',
        url: `${apiKeysUrl(machineUserId)}/${keyId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'REVOKED_MID'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_machine_token' })
    })

    it('returns 401 invalid_machine_token when the key expires after JWT issuance (live recheck)', async () => {
      const owner = await registerOwner(app, 'expired-mid')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-expiredmid')
      await createCredentialViaApi(app, owner.cookies, projectId, 'EXPIRED_MID', 'value')
      const { machineUserId, key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const listRes = await app.inject({
        method: 'GET',
        url: apiKeysUrl(machineUserId),
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      const keyId = listRes.json<{ data: { items: { id: string }[] } }>().data.items[0]?.id
      await withOrg(owner.orgId, (tx) =>
        tx
          .update(apiKeys)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(apiKeys.id, keyId as string))
      )

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'EXPIRED_MID'),
        headers: { authorization: `Bearer ${jwt}` },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'invalid_machine_token' })
    })
  })

  describe('AC-9: audit — actorType machine_user, version served, fail-closed, no secret leakage', () => {
    it('writes a credential.value_revealed audit row with actorType machine_user and no value field', async () => {
      const owner = await registerOwner(app, 'audit-row')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-audit')
      await createCredentialViaApi(app, owner.cookies, projectId, 'AUDITED_SECRET', 'sekret-value')
      const { machineUserId, key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const res = await app.inject({
        method: 'GET',
        url: machineCredentialValueUrl(projectId, 'AUDITED_SECRET'),
        headers: { authorization: `Bearer ${jwt}` },
      })
      expect(res.statusCode).toBe(200)

      const rows = await withOrg(owner.orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'credential.value_revealed'))
      )
      const row = rows.find(
        (r) => (r.payload as Record<string, unknown>)?.['machineUserId'] === machineUserId
      )
      expect(row).toBeDefined()
      expect(row?.actorType).toBe('machine_user')
      expect(row?.actorTokenId).toBeNull()
      const payload = row?.payload as Record<string, unknown>
      expect(payload).toMatchObject({ versionNumber: 1, machineUserId, name: 'AUDITED_SECRET' })
      expect(payload).not.toHaveProperty('value')
      expect(JSON.stringify(payload)).not.toContain('sekret-value')
    })

    it('rolls back and returns 503 audit_write_failed when the audit write fails', async () => {
      const owner = await registerOwner(app, 'audit-fail-closed')
      const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-auditfail')
      await createCredentialViaApi(app, owner.cookies, projectId, 'FAIL_CLOSED_SECRET', 'value')
      const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
      const jwt = await exchangeForMachineJwt(app, key)

      const auditSpy = vi
        .spyOn(machineAuditModule, 'writeMachineAuditEntry')
        .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
      try {
        const res = await app.inject({
          method: 'GET',
          url: machineCredentialValueUrl(projectId, 'FAIL_CLOSED_SECRET'),
          headers: { authorization: `Bearer ${jwt}` },
        })
        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({ code: 'audit_write_failed' })
      } finally {
        auditSpy.mockRestore()
      }
    })
  })

  describe('AC-27: rate limiting', () => {
    it('returns 429 on the 21st failed lookup for the same keyId within 60s', async () => {
      process.env['RATE_LIMIT_TEST_ENFORCE'] = 'true'
      try {
        const owner = await registerOwner(app, 'failed-lookup-limit')
        const projectId = await createProjectViaApi(app, owner.cookies, 'machine-cred-failedlimit')
        const { key } = await issueMachineUserAndKey(app, owner.cookies, projectId)
        const jwt = await exchangeForMachineJwt(app, key)

        const responses = []
        for (let i = 0; i < 21; i += 1) {
          responses.push(
            await app.inject({
              method: 'GET',
              url: machineCredentialValueUrl(projectId, `NEVER_EXISTS_${i}`),
              headers: { authorization: `Bearer ${jwt}` },
            })
          )
        }

        expect(responses.slice(0, 20).every((res) => res.statusCode === 404)).toBe(true)
        expect(responses[20]?.statusCode).toBe(429)
      } finally {
        delete process.env['RATE_LIMIT_TEST_ENFORCE']
      }
    }, 30_000)
  })
})
