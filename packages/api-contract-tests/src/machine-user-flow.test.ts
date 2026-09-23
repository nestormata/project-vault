/**
 * Story 43.1 AC-7 — the machine-user flow (`pk_` key → scoped JWT → credential fetch) is covered
 * by `packages/api-contract-tests`, the package positioned as the supported, cross-consumer
 * contract reference. Verified during story creation (2026-09-22) that no coverage of this flow
 * existed here before this file: `contract.test.ts`'s AC-22 describe block only comments on why
 * it skips a machine-user fixture for its own unrelated purpose, and grepping the whole package
 * for `/auth/machine-token` or `/machine/projects/` found nothing. Route-level coverage of the
 * same endpoints already exists in `apps/api/src/modules/machine-users/*.test.ts` and
 * `vault-action-agent-e2e.test.ts`, but neither of those is this package.
 *
 * Uses real `app.inject()` calls throughout — same interpretation of "against a running
 * instance" as `contract.test.ts` (see that file's module doc, point 1) — and this package's own
 * existing fixtures (`registerAndLogin`, `enrollMfa`, `createProject`, `createCredential`), since
 * mutating a machine user requires org role admin + an enrolled MFA factor
 * (docs/machine-users.md Part 2), and `enrollMfa` already drives the real TOTP enroll/
 * verify-enrollment routes rather than a DB shortcut.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { bootContractTestApp, type TestApp } from './fixtures/app-instance.js'
import { enrollMfa, registerAndLogin, type RegisteredUser } from './fixtures/auth.js'
import { cookieHeader } from './fixtures/http.js'
import { createProject } from './fixtures/resources.js'

let app: TestApp
let admin: RegisteredUser
let projectId: string
let credentialName: string
let credentialValue: string
let apiKey: string

async function issueMachineUserAndKey(owner: RegisteredUser, project: string): Promise<string> {
  const muRes = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/machine-users`,
    headers: { cookie: cookieHeader(owner.cookies) },
    payload: { name: 'contract-test-machine-user', role: 'member' },
  })
  expect(muRes.statusCode).toBe(201)
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id

  const keyRes = await app.inject({
    method: 'POST',
    url: `/api/v1/machine-users/${machineUserId}/api-keys`,
    headers: { cookie: cookieHeader(owner.cookies) },
    payload: { name: 'contract-test-key' },
  })
  expect(keyRes.statusCode).toBe(201)
  return keyRes.json<{ data: { key: string } }>().data.key
}

async function exchangeMachineToken(key: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/machine-token',
    headers: { authorization: `Bearer ${key}` },
  })
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { accessToken: string } }>().data.accessToken
}

describe('AC-7 — machine-user flow (pk_ key -> scoped JWT -> credential fetch)', () => {
  beforeAll(async () => {
    app = await bootContractTestApp()
    admin = await registerAndLogin(app, 'machine-flow-admin', 'Machine Flow Org')
    // docs/machine-users.md Part 2 — every mutating machine-user route requires org role admin
    // (registerAndLogin's caller is the org owner, already >= admin) AND an enrolled MFA factor.
    await enrollMfa(app, admin)

    projectId = await createProject(app, admin.cookies)
    credentialName = 'CONTRACT_TEST_SECRET'
    credentialValue = 'contract-test-real-secret-value'

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(admin.cookies) },
      payload: { name: credentialName, value: credentialValue },
    })
    expect(createRes.statusCode).toBe(201)

    apiKey = await issueMachineUserAndKey(admin, projectId)
  })

  afterAll(async () => {
    await app.close()
  })

  it('performs the real two-step runtime flow and returns the seeded credential value', async () => {
    const accessToken = await exchangeMachineToken(apiKey)

    const valueRes = await app.inject({
      method: 'GET',
      url: `/api/v1/machine/projects/${projectId}/credentials/${credentialName}/value`,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(valueRes.statusCode).toBe(200)
    const body = valueRes.json<{ data: { value: string } }>()
    expect(body.data.value).toBe(credentialValue)
  })

  it('rejects an unknown credential name with a documented 404 credential_not_found', async () => {
    const accessToken = await exchangeMachineToken(apiKey)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/machine/projects/${projectId}/credentials/DOES_NOT_EXIST/value`,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe('credential_not_found')
  })

  it('rejects a project id the access token is not scoped to with a documented 403 insufficient_role', async () => {
    const accessToken = await exchangeMachineToken(apiKey)
    const otherProjectId = await createProject(app, admin.cookies)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/machine/projects/${otherProjectId}/credentials/${credentialName}/value`,
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('insufficient_role')
  })

  describe('Story 43.4 AC-3 — optional invocation-context headers on the credential-value route', () => {
    async function revealedPayloads(): Promise<Array<Record<string, unknown>>> {
      const rows = await withOrg(admin.orgId, (tx) =>
        tx
          .select({ payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'credential.value_revealed'))
          .orderBy(desc(auditLogEntries.chainSeq))
      )
      return rows.map((r) => r.payload as Record<string, unknown>)
    }

    it('accepts x-vault-invocation/x-vault-target-command and records them (client-asserted) in the reveal audit entry', async () => {
      const accessToken = await exchangeMachineToken(apiKey)

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/machine/projects/${projectId}/credentials/${credentialName}/value`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-vault-invocation': 'run',
          'x-vault-target-command': 'psql',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json<{ data: { value: string } }>().data.value).toBe(credentialValue)
      const [latest] = await revealedPayloads()
      expect(latest).toMatchObject({
        name: credentialName,
        clientInvocation: 'run',
        clientTargetCommand: 'psql',
      })
      expect(JSON.stringify(latest)).not.toContain(credentialValue)
    })

    it('without the headers (older CLI, vault-action, any other machine caller) the response and audit payload are unaffected', async () => {
      const accessToken = await exchangeMachineToken(apiKey)

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/machine/projects/${projectId}/credentials/${credentialName}/value`,
        headers: { authorization: `Bearer ${accessToken}` },
      })

      expect(res.statusCode).toBe(200)
      const [latest] = await revealedPayloads()
      expect(Object.keys(latest ?? {}).sort()).toEqual(
        ['keyId', 'machineUserId', 'name', 'versionNumber'].sort()
      )
    })

    it('an invalid header value never fails the reveal — it is dropped and flagged', async () => {
      const accessToken = await exchangeMachineToken(apiKey)

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/machine/projects/${projectId}/credentials/${credentialName}/value`,
        headers: { authorization: `Bearer ${accessToken}`, 'x-vault-invocation': 'admin' },
      })

      expect(res.statusCode).toBe(200)
      const [latest] = await revealedPayloads()
      expect(latest).toMatchObject({ clientInvocationContextRejected: true })
      expect(latest).not.toHaveProperty('clientInvocation')
    })
  })

  it('rejects step 1 (token exchange) with an invalid key, distinct from a wrong-project failure', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/machine-token',
      headers: { authorization: 'Bearer pk_not_a_real_key' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('invalid_api_key')
  })
})
