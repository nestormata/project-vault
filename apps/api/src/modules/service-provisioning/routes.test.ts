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
// sonarjs/no-duplicate-string: this exact wrong-token value is asserted against across all
// three /api/v1/service/* auth test blocks (org-bootstrap, per-member, centralizeme-link).
const WRONG_TOKEN = 'definitely-wrong-token-value-000000'
// Story 33.1 AC4/AC5/AC10: the new audit event this route writes on a genuine first-time link
// only — asserted against (absence and presence) across multiple centralizeme-link tests.
const CENTRALIZEME_LINK_BACKFILLED_EVENT = 'org.centralizeme_link_backfilled'

/**
 * Story 32.1/33.1: shared by both the /members and /centralizeme-link describe blocks below —
 * each writes a real system-actor audit entry (writeSystemAuditEntry), which needs a real
 * (unsealed) vault to fetch the audit HMAC key. sonarjs/no-identical-functions: this exact
 * sequence (reset vault, init it with a caller-chosen secret, boot the app with the vault guard
 * enabled) was duplicated verbatim in both describe blocks — factored out here so they cannot
 * drift.
 */
async function freshVaultBackedApp(vaultSecret: string) {
  await resetVaultForTest()
  const { initVault } = await import('../../modules/vault/key-service.js')
  await initVaultForTest(initVault, vaultSecret)
  return createApp({ logger: false, vaultGuardEnabled: true })
}

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
      headers: { [TOKEN_HEADER]: WRONG_TOKEN },
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
    return freshVaultBackedApp(VAULT_SECRET)
  }

  function membersUrl(organizationId: string): string {
    return `${ROUTE_URL}/${organizationId}/members`
  }

  // Story 32.1 code-review finding: the /members route now requires the target org to be
  // CentralizeMe-managed (organizations.centralizeme_organization_id non-null) — every fixture
  // org in this describe block must carry one so the pre-existing AC1-AC8 tests keep exercising
  // the "allowed" path, not the new fail-closed check.
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
        centralizemeOrganizationId: `org_synthetic_${requestId}`,
      },
    })
    return successBody(res).data.organizationId
  }

  // Story 32.1 code-review finding: a PV org that exists but was never linked to CentralizeMe
  // (centralizeme_organization_id left null) — e.g. a self-registered customer org, or a
  // 26.1-provisioned org from before Story 30.2 shipped. Used to exercise the new fail-closed
  // check that blocks provisioning via this route for such an org.
  async function createNonCmOrg(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
    const requestId = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Non-CM Member Test Org ${requestId}`,
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

  // Story 32.1 code-review finding (High): the org-existence check above only confirmed the
  // organizationId is a real PV org — ANY real PV org, not necessarily one CentralizeMe manages.
  // A leaked SERVICE_PROVISIONING_TOKEN could otherwise inject an admin-role member into any org
  // in the system, including self-registered customers unrelated to CM. Nestor's explicit
  // decision after review: require centralizeme_organization_id to be non-null before allowing
  // provisioning via this route.
  it('code-review fix: an org that exists but is not CentralizeMe-managed is rejected with 403 organization_not_centralizeme_managed, no partial write', async () => {
    const app = await freshApp()
    const organizationId = await createNonCmOrg(app)
    const workosUserId = `user_${randomUUID()}`

    const res = await app.inject({
      method: 'POST',
      url: membersUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), workosUserId },
    })

    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('organization_not_centralizeme_managed')

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

  it('code-review fix: an org with a centralizemeOrganizationId set is allowed (control case)', async () => {
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
      headers: { [TOKEN_HEADER]: WRONG_TOKEN },
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

describe.sequential('PATCH /api/v1/service/organizations/:organizationId/centralizeme-link', () => {
  // Story 33.1 Task 3: this route writes a real system-actor audit entry
  // (AuditEvent.ORG_CENTRALIZEME_LINK_BACKFILLED) inside the same transaction as its
  // organizations UPDATE — writeSystemAuditEntry needs a real (unsealed) vault to fetch the
  // audit HMAC key, so this describe block boots the app against an initialized vault, mirroring
  // the /members describe block above (Story 32.1) and revoke-sessions-routes.test.ts's own
  // convention (31.1).
  const VAULT_SECRET = 'service-provisioning-centralizeme-link-routes-vault-secret'
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
    return freshVaultBackedApp(VAULT_SECRET)
  }

  function linkUrl(organizationId: string): string {
    return `${ROUTE_URL}/${organizationId}/centralizeme-link`
  }

  type LinkSuccessBody = {
    data: {
      organizationId: string
      centralizemeOrganizationId: string
      alreadyLinked: boolean
      dryRun: boolean
    }
  }

  function linkBody(res: InjectResponse): LinkSuccessBody {
    return res.json() as LinkSuccessBody
  }

  // Story 33.1 Decision 1/AC1: a "pre-existing" org fixture — created via the plain org-bootstrap
  // route WITHOUT a centralizemeOrganizationId, reproducing the exact pre-15.1-fix state this
  // story's backfill route exists to correct.
  async function createUnlinkedOrg(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
    const requestId = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Backfill Test Org ${requestId}`,
        workosUserId: `owner_${requestId}`,
      },
    })
    return successBody(res).data.organizationId
  }

  async function readStoredLink(organizationId: string): Promise<string | null> {
    const [row] = await getDb()
      .select({ centralizemeOrganizationId: organizations.centralizemeOrganizationId })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
    return row?.centralizemeOrganizationId ?? null
  }

  // A. Link an unlinked pre-existing organization
  it('AC1: links an unlinked pre-existing organization, returning 200 alreadyLinked:false', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const centralizemeOrganizationId = `org_acme_prod_${randomUUID()}`

    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId },
    })

    expect(res.statusCode).toBe(200)
    const body = linkBody(res)
    expect(body.data).toEqual({
      organizationId,
      centralizemeOrganizationId,
      alreadyLinked: false,
      dryRun: false,
    })
    expect(await readStoredLink(organizationId)).toBe(centralizemeOrganizationId)
    await app.close()
  })

  it('AC2: the route is reachable only via x-service-provisioning-token, never a human session', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)

    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      payload: { requestId: randomUUID(), centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC3: a nonexistent organizationId is rejected with 404 organization_not_found, no write attempted', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(randomUUID()),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(404)
    expect(errorBody(res).code).toBe('organization_not_found')
    await app.close()
  })

  it('AC4: a genuine first-time link writes an audit entry with the linked id and requestId', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const requestId = randomUUID()
    const centralizemeOrganizationId = `org_${randomUUID()}`

    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId, centralizemeOrganizationId },
    })
    expect(res.statusCode).toBe(200)

    const { auditLogEntries } = await import('@project-vault/db/schema')
    const rows = await withOrg(organizationId, (tx) =>
      tx
        .select({ eventType: auditLogEntries.eventType, payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, organizationId),
            eq(auditLogEntries.eventType, CENTRALIZEME_LINK_BACKFILLED_EVENT)
          )
        )
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toMatchObject({ centralizemeOrganizationId, requestId })
    await app.close()
  })

  // B. Idempotent on an exact-match replay; fail-closed on any mismatch
  it('AC5: an exact-match replay returns 200 alreadyLinked:true, no write, no audit entry', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const centralizemeOrganizationId = `org_${randomUUID()}`

    const first = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId },
    })
    expect(second.statusCode).toBe(200)
    expect(linkBody(second).data).toEqual({
      organizationId,
      centralizemeOrganizationId,
      alreadyLinked: true,
      dryRun: false,
    })

    const { auditLogEntries } = await import('@project-vault/db/schema')
    const rows = await withOrg(organizationId, (tx) =>
      tx
        .select({ eventType: auditLogEntries.eventType })
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, organizationId),
            eq(auditLogEntries.eventType, CENTRALIZEME_LINK_BACKFILLED_EVENT)
          )
        )
    )
    expect(rows).toHaveLength(1)
    await app.close()
  })

  it('AC6: a call with a different value than the one already stored is rejected 409 centralizeme_link_mismatch, no write', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const original = `org_acme_prod_${randomUUID()}`

    const first = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: original },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        centralizemeOrganizationId: `org_acme_staging_${randomUUID()}`,
      },
    })
    expect(second.statusCode).toBe(409)
    expect(errorBody(second).code).toBe('centralizeme_link_mismatch')
    expect(await readStoredLink(organizationId)).toBe(original)
    await app.close()
  })

  it('AC7: a value already claimed by a different PV org is rejected 409 centralizeme_id_already_linked (pre-check fast path)', async () => {
    const app = await freshApp()
    const claimed = `org_${randomUUID()}`
    const orgA = await createUnlinkedOrg(app)
    const orgB = await createUnlinkedOrg(app)

    const first = await app.inject({
      method: 'PATCH',
      url: linkUrl(orgA),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: claimed },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PATCH',
      url: linkUrl(orgB),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: claimed },
    })
    expect(second.statusCode).toBe(409)
    expect(errorBody(second).code).toBe('centralizeme_id_already_linked')
    expect(await readStoredLink(orgB)).toBeNull()
    await app.close()
  })

  it('AC7: genuine concurrency — two different orgs racing to claim the same centralizemeOrganizationId, exactly one wins', async () => {
    const app = await freshApp()
    const claimed = `org_${randomUUID()}`
    const orgA = await createUnlinkedOrg(app)
    const orgB = await createUnlinkedOrg(app)

    const [a, b] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: linkUrl(orgA),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), centralizemeOrganizationId: claimed },
      }),
      app.inject({
        method: 'PATCH',
        url: linkUrl(orgB),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), centralizemeOrganizationId: claimed },
      }),
    ])

    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([200, 409])
    const winner = a.statusCode === 200 ? a : b
    const loser = a.statusCode === 200 ? b : a
    expect(linkBody(winner).data.alreadyLinked).toBe(false)
    expect(errorBody(loser).code).toBe('centralizeme_id_already_linked')
    await app.close()
  })

  // C. dryRun preview mode never mutates
  it('AC8: dryRun:true against an unlinked org previews alreadyLinked:false without writing', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const centralizemeOrganizationId = `org_${randomUUID()}`

    const dry = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId, dryRun: true },
    })
    expect(dry.statusCode).toBe(200)
    expect(linkBody(dry).data).toEqual({
      organizationId,
      centralizemeOrganizationId,
      alreadyLinked: false,
      dryRun: true,
    })
    expect(await readStoredLink(organizationId)).toBeNull()

    // A follow-up real call on the same input still returns alreadyLinked:false, proving the
    // dry run made no change.
    const real = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId },
    })
    expect(real.statusCode).toBe(200)
    expect(linkBody(real).data.alreadyLinked).toBe(false)

    // The dry run is repeatable with no side effect between calls, even after the real link.
    const dryAfter = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId, dryRun: true },
    })
    expect(dryAfter.statusCode).toBe(200)
    expect(linkBody(dryAfter).data).toEqual({
      organizationId,
      centralizemeOrganizationId,
      alreadyLinked: true,
      dryRun: true,
    })
    await app.close()
  })

  it('AC9: dryRun:true against an already-correctly-linked org previews alreadyLinked:true', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const centralizemeOrganizationId = `org_${randomUUID()}`
    await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId },
    })

    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId, dryRun: true },
    })
    expect(res.statusCode).toBe(200)
    expect(linkBody(res).data).toEqual({
      organizationId,
      centralizemeOrganizationId,
      alreadyLinked: true,
      dryRun: true,
    })
    await app.close()
  })

  it('AC9: dryRun:true against a mismatch previews the identical 409 centralizeme_link_mismatch, no write', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const original = `org_${randomUUID()}`
    await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: original },
    })

    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        centralizemeOrganizationId: `org_other_${randomUUID()}`,
        dryRun: true,
      },
    })
    expect(res.statusCode).toBe(409)
    expect(errorBody(res).code).toBe('centralizeme_link_mismatch')
    expect(await readStoredLink(organizationId)).toBe(original)
    await app.close()
  })

  it('AC9: dryRun:true against a claimed-elsewhere id previews the identical 409 centralizeme_id_already_linked, no write', async () => {
    const app = await freshApp()
    const claimed = `org_${randomUUID()}`
    const orgA = await createUnlinkedOrg(app)
    const orgB = await createUnlinkedOrg(app)
    await app.inject({
      method: 'PATCH',
      url: linkUrl(orgA),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: claimed },
    })

    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(orgB),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: claimed, dryRun: true },
    })
    expect(res.statusCode).toBe(409)
    expect(errorBody(res).code).toBe('centralizeme_id_already_linked')
    expect(await readStoredLink(orgB)).toBeNull()
    await app.close()
  })

  it('AC10: no audit entry is written for a dryRun:true call on the link branch', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const centralizemeOrganizationId = `org_${randomUUID()}`

    await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId, dryRun: true },
    })

    const { auditLogEntries } = await import('@project-vault/db/schema')
    const rows = await withOrg(organizationId, (tx) =>
      tx
        .select({ eventType: auditLogEntries.eventType })
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, organizationId),
            eq(auditLogEntries.eventType, CENTRALIZEME_LINK_BACKFILLED_EVENT)
          )
        )
    )
    expect(rows).toHaveLength(0)
    await app.close()
  })

  // D. Fail-closed input and auth handling
  it('AC11: missing requestId is a 422 validation error, no DB query attempted', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC11: whitespace-only centralizemeOrganizationId is a 422 validation error (post-trim)', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: '   ' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC11: a malformed (non-UUID) organizationId path param is rejected with 422', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl('not-a-uuid'),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC11: an unrecognized extra body field is rejected with 422 (.strict())', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        centralizemeOrganizationId: `org_${randomUUID()}`,
        extra: 'nope',
      },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC12: missing token is rejected with 403', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      payload: { requestId: randomUUID(), centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC12: wrong token is rejected with the SAME 403 body as a missing token', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const res = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: WRONG_TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC12: unset SERVICE_PROVISIONING_TOKEN makes this route unreachable (403) even with the right-shaped header', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)

    const { env } = await import('../../config/env.js')
    delete (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN']
    const unsetApp = await createApp({ logger: false })

    const res = await unsetApp.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: `org_${randomUUID()}` },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await unsetApp.close()
    await app.close()
  })

  // F. Concurrency and data-quality hardening
  it('AC17: genuine concurrency — two different values racing for the SAME organizationId, exactly one wins, loser gets 409 centralizeme_link_mismatch', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const valueA = `org_a_${randomUUID()}`
    const valueB = `org_b_${randomUUID()}`

    const [a, b] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: linkUrl(organizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), centralizemeOrganizationId: valueA },
      }),
      app.inject({
        method: 'PATCH',
        url: linkUrl(organizationId),
        headers: { [TOKEN_HEADER]: TOKEN },
        payload: { requestId: randomUUID(), centralizemeOrganizationId: valueB },
      }),
    ])

    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([200, 409])
    const winner = a.statusCode === 200 ? a : b
    const loser = a.statusCode === 200 ? b : a
    expect(linkBody(winner).data.alreadyLinked).toBe(false)
    expect(errorBody(loser).code).toBe('centralizeme_link_mismatch')

    const stored = await readStoredLink(organizationId)
    expect(stored).toBe(linkBody(winner).data.centralizemeOrganizationId)
    await app.close()
  })

  it('AC18: string comparison is exact and case-sensitive — a differently-cased id is a mismatch, not an idempotent no-op', async () => {
    const app = await freshApp()
    const organizationId = await createUnlinkedOrg(app)
    const suffix = randomUUID()
    const lower = `org_acme_prod_${suffix}`
    const upper = `org_ACME_prod_${suffix}`

    const first = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: lower },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'PATCH',
      url: linkUrl(organizationId),
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), centralizemeOrganizationId: upper },
    })
    expect(second.statusCode).toBe(409)
    expect(errorBody(second).code).toBe('centralizeme_link_mismatch')
    expect(await readStoredLink(organizationId)).toBe(lower)
    await app.close()
  })
})
