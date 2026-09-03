import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { externalIdentities, organizations, orgMemberships } from '@project-vault/db/schema'
import { createApp } from '../../app.js'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const TOKEN = 'test-only-service-provisioning-token-32-bytes-min'
const TOKEN_HEADER = 'x-service-provisioning-token'
const ROUTE_URL = '/api/v1/service/organizations'

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>>
type SuccessBody = { data: { organizationId: string; userId: string; externalIdentityId: string } }
type ErrorBody = { code: string; message: string }

function successBody(res: InjectResponse): SuccessBody {
  return res.json() as SuccessBody
}

function errorBody(res: InjectResponse): ErrorBody {
  return res.json() as ErrorBody
}

describe('POST /api/v1/service/organizations', () => {
  // env.ts's `env` singleton is computed once per test-file module load; mutate it directly
  // (a plain, non-frozen object) rather than process.env, which env.ts would only re-read on a
  // fresh module evaluation that already happened before this test file's beforeEach runs.
  let originalToken: string | undefined

  beforeEach(async () => {
    const { env } = await import('../../config/env.js')
    originalToken = (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] as
      string | undefined
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = TOKEN
  })

  afterEach(async () => {
    const { env } = await import('../../config/env.js')
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = originalToken
  })

  async function freshApp() {
    return createApp({ logger: false })
  }

  it('AC-1/AC-3: atomically creates an org, user, and external identity, returning 201', async () => {
    const app = await freshApp()
    const requestId = randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Test Org ${requestId}`,
        workosUserId: `user_${requestId}`,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    expect(body.data.organizationId).toBeTruthy()
    expect(body.data.userId).toBeTruthy()
    expect(body.data.externalIdentityId).toBeTruthy()
    await app.close()
  })

  it('Story 30.2: an optional centralizemeOrganizationId is persisted on the organization row', async () => {
    const app = await freshApp()
    const requestId = randomUUID()
    const centralizemeOrganizationId = `org_synthetic_${requestId}`

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `CM Org ${requestId}`,
        workosUserId: `user_${requestId}`,
        centralizemeOrganizationId,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    const [row] = await getDb()
      .select({ centralizemeOrganizationId: organizations.centralizemeOrganizationId })
      .from(organizations)
      .where(eq(organizations.id, body.data.organizationId))
    expect(row?.centralizemeOrganizationId).toBe(centralizemeOrganizationId)
    await app.close()
  })

  it('Story 30.2: omitting centralizemeOrganizationId (CM caller not yet updated) leaves it null', async () => {
    const app = await freshApp()
    const requestId = randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `No CM Org ${requestId}`,
        workosUserId: `user_${requestId}`,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    const [row] = await getDb()
      .select({ centralizemeOrganizationId: organizations.centralizemeOrganizationId })
      .from(organizations)
      .where(eq(organizations.id, body.data.organizationId))
    expect(row?.centralizemeOrganizationId).toBeNull()
    await app.close()
  })

  it('AC-4: a repeated call with the same requestId returns the SAME result, not a duplicate', async () => {
    const app = await freshApp()
    const requestId = randomUUID()
    const payload = {
      requestId,
      organizationName: `Replay Org ${requestId}`,
      workosUserId: `user_${requestId}`,
    }

    const first = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload,
    })
    const second = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload,
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(successBody(second).data).toEqual(successBody(first).data)
    await app.close()
  })

  it('AC-4: genuine concurrency — two simultaneous requests with the same requestId create exactly one org', async () => {
    const app = await freshApp()
    const requestId = randomUUID()
    const payload = {
      requestId,
      organizationName: `Concurrent Org ${requestId}`,
      workosUserId: `user_${requestId}`,
    }

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: ROUTE_URL,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: ROUTE_URL,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload,
      }),
    ])

    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(successBody(a).data).toEqual(successBody(b).data)
    await app.close()
  })

  it('AC-5: a different requestId with the same name/subject creates a genuinely new org', async () => {
    const app = await freshApp()
    const suffix = randomUUID()
    const first = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: `Dup Name Org ${suffix}`,
        workosUserId: `user_${suffix}`,
      },
    })
    const second = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: `Dup Name Org ${suffix}`,
        workosUserId: `user_${suffix}`,
      },
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(successBody(second).data.organizationId).not.toBe(successBody(first).data.organizationId)
    await app.close()
  })

  it('AC-7: missing token is rejected with 403', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      payload: {
        requestId: randomUUID(),
        organizationName: 'No Token Org',
        workosUserId: 'user_no_token',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC-7: wrong token is rejected with the SAME 403 body as a missing token', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: 'definitely-wrong-token-value-000000' },
      payload: {
        requestId: randomUUID(),
        organizationName: 'Wrong Token Org',
        workosUserId: 'user_wrong_token',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC-8: unset SERVICE_PROVISIONING_TOKEN makes the route unreachable (403) even with the right-shaped header', async () => {
    const { env } = await import('../../config/env.js')
    delete (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN']
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: 'Unset Token Org',
        workosUserId: 'user_unset_token',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC-6: missing requestId is a 422 validation error, no partial write', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { organizationName: 'No Request Id Org', workosUserId: 'user_x' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC-6: empty organizationName is a 422 validation error', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), organizationName: '', workosUserId: 'user_x' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC-6: empty workosUserId is a 422 validation error', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), organizationName: 'Some Org', workosUserId: '' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })
})

describe.sequential('POST /api/v1/service/organizations/:organizationId/members', () => {
  // Story 32.1 Task 6: this route writes a real system-actor audit entry
  // (AuditEvent.ORG_MEMBER_PROVISIONED) inside the same transaction as its user/membership/
  // external-identity writes — unlike the plain org-bootstrap route above (26.1), which writes no
  // audit entry at all. writeSystemAuditEntry needs a real (unsealed) vault to fetch the audit
  // HMAC key, so this describe block boots the app against an initialized vault, mirroring
  // revoke-sessions-routes.test.ts's own convention (31.1, the other route in this module that
  // audits). describe.sequential because vault init/reset is process-global state, same
  // rationale as that file's own describe.sequential.
  const VAULT_SECRET = 'service-provisioning-member-routes-vault-secret'
  let originalToken: string | undefined

  beforeEach(async () => {
    configureAuthIntegrationEnv()
    const { env } = await import('../../config/env.js')
    originalToken = (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] as
      string | undefined
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = TOKEN
  })

  afterEach(async () => {
    const { env } = await import('../../config/env.js')
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = originalToken
    await resetVaultForTest()
  })

  async function freshApp() {
    await resetVaultForTest()
    const { initVault } = await import('../../modules/vault/key-service.js')
    await initVaultForTest(initVault, VAULT_SECRET)
    return createApp({ logger: false, vaultGuardEnabled: true })
  }

  function membersUrl(organizationId: string): string {
    return `${ROUTE_URL}/${organizationId}/members`
  }

  async function createOrg(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
    const requestId = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Member Test Org ${requestId}`,
        workosUserId: `owner_${requestId}`,
      },
    })
    return successBody(res).data.organizationId
  }

  // A. Atomic user + membership + external-identity creation on an existing org
  it('AC1/AC3/AC4: atomically creates a user, membership, and external identity on an existing org, returning 201', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    expect(body.data.userId).toBeTruthy()
    expect(body.data.externalIdentityId).toBeTruthy()

    const [membership] = await withOrg(organizationId, (tx) =>
      tx
        .select({ role: orgMemberships.role, status: orgMemberships.status })
        .from(orgMemberships)
        .where(
          and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, body.data.userId))
        )
    )
    expect(membership?.role).toBe('member')
    expect(membership?.status).toBe('active')

    const [identity] = await withOrg(organizationId, (tx) =>
      tx
        .select({
          providerName: externalIdentities.providerName,
          subject: externalIdentities.externalSubject,
        })
        .from(externalIdentities)
        .where(eq(externalIdentities.id, body.data.externalIdentityId))
    )
    expect(identity?.providerName).toBe('workos')
    expect(identity?.subject).toBe(workosUserId)
    await app.close()
  })

  it('AC1: an explicit role is honored', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId, role: 'admin' },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    const [membership] = await withOrg(organizationId, (tx) =>
      tx
        .select({ role: orgMemberships.role })
        .from(orgMemberships)
        .where(
          and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, body.data.userId))
        )
    )
    expect(membership?.role).toBe('admin')
    await app.close()
  })

  it('AC2: role "owner" is rejected with 400 invalid_role before any write', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId, role: 'owner' },
    })

    expect(res.statusCode).toBe(400)
    expect(errorBody(res).code).toBe('invalid_role')

    const rows = await withOrg(organizationId, (tx) =>
      tx
        .select({ id: externalIdentities.id })
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.orgId, organizationId),
            eq(externalIdentities.externalSubject, workosUserId)
          )
        )
    )
    expect(rows).toHaveLength(0)
    await app.close()
  })

  it('AC2: an unrecognized role value is rejected with 400 invalid_role', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)

    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}`, role: 'bogus' },
    })

    expect(res.statusCode).toBe(400)
    expect(errorBody(res).code).toBe('invalid_role')
    await app.close()
  })

  // B. Idempotent on the existing (organizationId, workosUserId) external-identity key
  it('AC5: a repeated call for the same organizationId+workosUserId returns the SAME result with 200', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const payload = { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` }

    const first = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload,
    })
    const second = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { ...payload, requestId: randomUUID() },
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    expect(successBody(second).data).toEqual(successBody(first).data)
    await app.close()
  })

  it('AC5: genuine concurrency — two simultaneous requests for the same pair create exactly one user', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: membersUrl(organizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), workosUserId },
      }),
      app.inject({
        method: 'POST',
        url: membersUrl(organizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), workosUserId },
      }),
    ])

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
    expect(successBody(a).data).toEqual(successBody(b).data)

    const rows = await withOrg(organizationId, (tx) =>
      tx
        .select({ id: externalIdentities.id })
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.orgId, organizationId),
            eq(externalIdentities.externalSubject, workosUserId)
          )
        )
    )
    expect(rows).toHaveLength(1)
    await app.close()
  })

  it('AC6: a different workosUserId against the same org creates a genuinely new member', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)

    const first = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` },
    })
    const second = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` },
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(successBody(second).data.userId).not.toBe(successBody(first).data.userId)
    await app.close()
  })

  it('AC7: the same workosUserId against two different orgs creates two independent users with no cross-org leakage', async () => {
    const app = await freshApp()
    const orgA = await createOrg(app)
    const orgB = await createOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const resA = await app.inject({
      method: 'POST',
      url: membersUrl(orgA),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })
    const resB = await app.inject({
      method: 'POST',
      url: membersUrl(orgB),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })

    expect(resA.statusCode).toBe(201)
    expect(resB.statusCode).toBe(201)
    expect(successBody(resB).data.userId).not.toBe(successBody(resA).data.userId)
    await app.close()
  })

  it('AC8: a since-deactivated member is reactivated on idempotent replay', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const first = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })
    expect(first.statusCode).toBe(201)
    const { userId, externalIdentityId } = successBody(first).data

    await withOrg(organizationId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'deactivated' })
        .where(and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, userId)))
    )

    const replay = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })

    expect(replay.statusCode).toBe(200)
    expect(successBody(replay).data).toEqual({ userId, externalIdentityId })

    const [membership] = await withOrg(organizationId, (tx) =>
      tx
        .select({ status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, organizationId), eq(orgMemberships.userId, userId)))
    )
    expect(membership?.status).toBe('active')
    await app.close()
  })

  // C. Fail-closed input and auth handling
  it('AC9: missing requestId is a 422 validation error, no partial write', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { workosUserId: `user_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC9: whitespace-only workosUserId is a 422 validation error (post-trim)', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId: '   ' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC9: a malformed (non-UUID) organizationId path param is rejected with 422, never a raw DB error', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: membersUrl('not-a-uuid'),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC9: a nonexistent organizationId is rejected with 404 organization_not_found, no partial write', async () => {
    const app = await freshApp()
    const workosUserId = `user_${randomUUID()}`
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(randomUUID()),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })
    expect(res.statusCode).toBe(404)
    expect(errorBody(res).code).toBe('organization_not_found')
    await app.close()
  })

  it('AC10: missing token is rejected with 403', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC10: wrong token is rejected with the SAME 403 body as a missing token', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)
    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: 'definitely-wrong-token-value-000000' },
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC11: unset SERVICE_PROVISIONING_TOKEN makes this route unreachable (403) even with the right-shaped header', async () => {
    const app = await freshApp()
    const organizationId = await createOrg(app)

    const { env } = await import('../../config/env.js')
    delete (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN']
    const unsetApp = await createApp({ logger: false })

    const res = await unsetApp.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId: `user_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await unsetApp.close()
    await app.close()
  })
})
