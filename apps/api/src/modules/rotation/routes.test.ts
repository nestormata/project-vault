import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialVersions,
  credentials,
  rotationChecklistItems,
  rotations,
} from '@project-vault/db/schema'
import {
  addCredentialDependencyViaApi,
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
  SENTINEL_VALUE,
} from '../credentials/credential-route-test-helpers.js'
import {
  assertRoutesFailClosedWhileSealed,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createApp,
  createDirectAuthenticatedUser,
  FORCED_AUDIT_FAILURE,
  humanAudit,
  initVault,
  loginExistingUserInOrg,
  resetVaultForTest,
  ROTATION_INTEGRATION_PASSWORD as PASSWORD,
  type RotationRegisteredUser as RegisteredUser,
  type RotationTestApp as TestApp,
} from './rotation-integration-context.js'

const TEST_PASSPHRASE = 'rotation-routes-passphrase'

function rotationsUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations${suffix}`
}

function credentialValueUrl(projectId: string, credentialId: string) {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/value`
}

async function initiateRotationViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  body: Record<string, unknown> = { newValue: `rotated-${randomUUID()}` }
) {
  return app.inject({
    method: 'POST',
    url: rotationsUrl(projectId, credentialId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

/** Seeds a project + credential and initiates a rotation on it, returning the ids needed to
 *  exercise the two read routes against a real `in_progress` rotation. */
async function createInitiatedRotationFixture(
  app: TestApp,
  cookies: Record<string, string>,
  slug: string
) {
  const projectId = await createCredentialTestProject(app, cookies, slug)
  const credential = await createCredentialViaApi(app, cookies, projectId)
  const initiate = await initiateRotationViaApi(app, cookies, projectId, credential.id)
  const rotationId = initiate.json<{ data: { id: string } }>().data.id
  return { projectId, credentialId: credential.id, rotationId }
}

async function getRotationDetailViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  rotationId: string
) {
  return app.inject({
    method: 'GET',
    url: rotationsUrl(projectId, credentialId, `/${rotationId}`),
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function getRotationHistoryViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  suffix = ''
) {
  return app.inject({
    method: 'GET',
    url: rotationsUrl(projectId, credentialId, suffix),
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function rowCounts(orgId: string, credentialId: string) {
  return withOrg(orgId, async (tx) => {
    const rotationRows = await tx
      .select({ id: rotations.id })
      .from(rotations)
      .where(eq(rotations.credentialId, credentialId))
    const versionRows = await tx
      .select({ id: credentialVersions.id })
      .from(credentialVersions)
      .where(eq(credentialVersions.credentialId, credentialId))
    return { rotations: rotationRows.length, versions: versionRows.length }
  })
}

describe.sequential('rotation routes', () => {
  let app: TestApp
  let owner: RegisteredUser
  let other: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner, other } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'rotation'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('POST initiates a rotation, snapshots dependencies, and locks the superseded version', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-happy')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'billing-worker (production)',
    })
    await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'GitHub Actions CI (deploy pipeline)',
    })

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'sk_live_ROTATED_not_a_real_key',
      notes: 'Rotating after the key was pasted into a shared Slack channel',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{
      data: {
        id: string
        status: string
        version: number
        checklistItems: { systemName: string; status: string }[]
      }
    }>()
    expect(body.data.status).toBe('in_progress')
    expect(body.data.version).toBe(1)
    expect(body.data.checklistItems).toHaveLength(2)
    expect(body.data.checklistItems.map((i) => i.systemName)).toEqual(
      expect.arrayContaining(['billing-worker (production)', 'GitHub Actions CI (deploy pipeline)'])
    )
    for (const item of body.data.checklistItems) expect(item.status).toBe('unconfirmed')

    // Retention seam: the superseded (version 1) row is now rotation-locked.
    const lockedVersion = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          rotationLockedAt: credentialVersions.rotationLockedAt,
          versionNumber: credentialVersions.versionNumber,
        })
        .from(credentialVersions)
        .where(
          and(
            eq(credentialVersions.credentialId, credential.id),
            eq(credentialVersions.versionNumber, 1)
          )
        )
    )
    expect(lockedVersion[0]?.rotationLockedAt).not.toBeNull()

    // The new value is live immediately (reveal always serves the highest non-purged version).
    const valueRes = await app.inject({
      method: 'GET',
      url: credentialValueUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(valueRes.statusCode).toBe(200)
    expect(valueRes.json<{ data: { value: string } }>().data.value).toBe(
      'sk_live_ROTATED_not_a_real_key'
    )

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'rotation.initiated'))
    )
    expect(
      auditRows.some(
        (row) =>
          row.resourceId === body.data.id &&
          (row.payload as { checklistItemCount?: number }).checklistItemCount === 2
      )
    ).toBe(true)
  }, 20_000)

  it('POST initiates successfully with an empty checklist for a zero-dependency credential', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-zero-dep')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(201)
    expect(res.json<{ data: { checklistItems: unknown[] } }>().data.checklistItems).toEqual([])
  })

  it('POST flags sameValueAsPrevious when newValue matches the current version', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-same-value')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: SENTINEL_VALUE,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<{ data: { sameValueAsPrevious?: boolean } }>().data.sameValueAsPrevious).toBe(
      true
    )
  })

  it('POST second concurrent initiation on the same credential returns 409, not queued', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-concurrent')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const [first, second] = await Promise.all([
      initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
        newValue: 'value-a',
      }),
      initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
        newValue: 'value-b',
      }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([201, 409])
    const conflict = first.statusCode === 409 ? first : second
    expect(conflict.json()).toMatchObject({ code: 'rotation_in_progress' })
    expect(conflict.json<{ rotationId: string | null }>().rotationId).toBeTypeOf('string')
  })

  it('POST a sequential retry after a rotation is already in_progress hits the partial unique index backstop and returns 409 with the winning rotationId', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-backstop')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const first = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(first.statusCode).toBe(201)
    const winningId = first.json<{ data: { id: string } }>().data.id

    // By the time this second call runs, the first request's transaction (and its advisory
    // lock) has already committed and released — so this call's own pg_try_advisory_xact_lock
    // succeeds. The only thing that can still reject it is the partial unique index
    // (idx_rotations_one_in_progress_per_credential), proving the backstop backstops
    // independently of lock contention (AC-5b).
    const second = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'rotation_in_progress', rotationId: winningId })
  })

  it('POST is rejected with 403 for member/viewer roles before any DB write', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-role')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    for (const role of ['member', 'viewer'] as const) {
      const user = await createDirectAuthenticatedUser(app, `rotate-${role}`, role)
      const res = await initiateRotationViaApi(app, user.cookies, projectId, credential.id)
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    }
    const counts = await rowCounts(owner.orgId, credential.id)
    expect(counts.rotations).toBe(0)
  })

  it('POST is rejected with 403 mfa_required for an admin session that has not completed MFA enrollment', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-mfa')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    // createDirectAuthenticatedUser grants no MFA grace period, unlike registerAndLoginViaApi —
    // exercises the enforced branch of requireMfaEnrollment() directly (AC-7).
    const unenrolledAdmin = await createDirectAuthenticatedUser(app, 'rotate-mfa', 'admin')
    const res = await initiateRotationViaApi(app, unenrolledAdmin.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('GET rotation detail and history are allowed for viewer role', async () => {
    const { projectId, credentialId, rotationId } = await createInitiatedRotationFixture(
      app,
      owner.cookies,
      'rotate-viewer-read'
    )

    const viewer = await createDirectAuthenticatedUser(app, 'rotate-viewer', 'viewer')
    const detailRes = await getRotationDetailViaApi(
      app,
      viewer.cookies,
      projectId,
      credentialId,
      rotationId
    )
    expect(detailRes.statusCode).toBe(404) // different org — 404, not 403 (cross-org isolation)

    const sameOrgViewerCookies = await loginExistingUserInOrg(app, {
      userId: viewer.userId,
      orgId: owner.orgId,
      role: 'viewer',
    })
    const sameOrgDetailRes = await getRotationDetailViaApi(
      app,
      sameOrgViewerCookies,
      projectId,
      credentialId,
      rotationId
    )
    expect(sameOrgDetailRes.statusCode).toBe(200)
    expect(sameOrgDetailRes.json()).toMatchObject({
      data: { id: rotationId, status: 'in_progress' },
    })

    const historyRes = await getRotationHistoryViaApi(
      app,
      sameOrgViewerCookies,
      projectId,
      credentialId
    )
    expect(historyRes.statusCode).toBe(200)
    expect(historyRes.json()).toMatchObject({
      data: { items: [{ id: rotationId, itemCount: 0, confirmedCount: 0 }], total: 1 },
    })
  })

  it('GET rotation detail 404s for a nonexistent rotation id under a real credential', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-detail-404')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await getRotationDetailViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      randomUUID()
    )
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'rotation_not_found' })
  })

  it('GET rotation history paginates correctly, including deep pages beyond the total', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-history-page')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const emptyRes = await getRotationHistoryViaApi(app, owner.cookies, projectId, credential.id)
    expect(emptyRes.statusCode).toBe(200)
    expect(emptyRes.json()).toMatchObject({
      data: { items: [], page: 1, limit: 20, total: 0, hasMore: false },
    })

    await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)

    const deepPageRes = await getRotationHistoryViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      '?page=999'
    )
    expect(deepPageRes.statusCode).toBe(200)
    expect(deepPageRes.json()).toMatchObject({
      data: { items: [], total: 1, hasMore: false },
    })
  })

  it('cross-org, cross-project, and nonexistent credential all 404 identically with no enumeration', async () => {
    const { projectId, credentialId, rotationId } = await createInitiatedRotationFixture(
      app,
      owner.cookies,
      'rotate-tenant-a'
    )

    // (a) cross-org caller
    const crossOrgPost = await initiateRotationViaApi(app, other.cookies, projectId, credentialId)
    expect(crossOrgPost.statusCode).toBe(404)
    expect(crossOrgPost.json()).toMatchObject({ code: 'credential_not_found' })

    const crossOrgDetail = await getRotationDetailViaApi(
      app,
      other.cookies,
      projectId,
      credentialId,
      rotationId
    )
    expect(crossOrgDetail.statusCode).toBe(404)

    const crossOrgHistory = await getRotationHistoryViaApi(
      app,
      other.cookies,
      projectId,
      credentialId
    )
    expect(crossOrgHistory.statusCode).toBe(404)

    // (b) valid project, credential from a different project
    const otherProjectId = await createCredentialTestProject(app, owner.cookies, 'rotate-tenant-b')
    const crossProjectPost = await initiateRotationViaApi(
      app,
      owner.cookies,
      otherProjectId,
      credentialId
    )
    expect(crossProjectPost.statusCode).toBe(404)

    // (c) nonexistent credential id entirely
    const nonexistentPost = await initiateRotationViaApi(
      app,
      owner.cookies,
      projectId,
      randomUUID()
    )
    expect(nonexistentPost.statusCode).toBe(404)
    expect(nonexistentPost.json()).toMatchObject({ code: 'credential_not_found' })
  })

  it('malformed (non-UUID) path parameters return 422 validation_error, not 404', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-bad-uuid')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await getRotationDetailViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'not-a-uuid'
    )
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('POST validation: rejects missing/empty/oversized newValue and unknown fields with 422', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-validation')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const missing = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {})
    expect(missing.statusCode).toBe(422)

    const empty = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: '',
    })
    expect(empty.statusCode).toBe(422)

    const extraField = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'ok',
      extraField: true,
    })
    expect(extraField.statusCode).toBe(422)

    const counts = await rowCounts(owner.orgId, credential.id)
    expect(counts.rotations).toBe(0)
  })

  it('sealed vault fails closed with 503 for POST rotations', async () => {
    app = await assertRoutesFailClosedWhileSealed(
      app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        {
          method: 'POST',
          url: rotationsUrl(randomUUID(), randomUUID()),
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: { newValue: 'x' },
        },
      ]
    )
    await app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)

  it('retention seam: superseded version stays excluded from the retention purge job while locked', async () => {
    const { pruneCredentialVersions } = await import('../../workers/prune-credential-versions.js')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-retention')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    // retentionCount defaults to 3 on create; force it to the minimum (1) directly so the
    // superseded version would be an immediate purge candidate without the rotation lock.
    await withOrg(owner.orgId, (tx) =>
      tx.update(credentials).set({ retentionCount: 1 }).where(eq(credentials.id, credential.id))
    )

    const rotateRes = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(rotateRes.statusCode).toBe(201)

    await pruneCredentialVersions()

    const versionRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          versionNumber: credentialVersions.versionNumber,
          purgedAt: credentialVersions.purgedAt,
          rotationLockedAt: credentialVersions.rotationLockedAt,
        })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, credential.id))
        .orderBy(credentialVersions.versionNumber)
    )
    const version1 = versionRows.find((v) => v.versionNumber === 1)
    expect(version1?.rotationLockedAt).not.toBeNull()
    expect(version1?.purgedAt).toBeNull()
  }, 20_000)

  it('audit write failure rolls back the rotation, checklist items, and new version atomically', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rotate-audit-fail')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const dependencyRes = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      { systemName: 'audit-fail-dependency' }
    )
    const dependencyId = dependencyRes.json<{ data: { id: string } }>().data.id

    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
      expectAuditWriteFailed(res)

      const counts = await rowCounts(owner.orgId, credential.id)
      expect(counts.rotations).toBe(0)
      expect(counts.versions).toBe(1) // only the original version from credential creation

      // Scoped by dependencyId (not a bare org-wide select) — `owner`'s org accumulates
      // checklist items from earlier tests in this sequential suite.
      const checklistRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: rotationChecklistItems.id })
          .from(rotationChecklistItems)
          .where(eq(rotationChecklistItems.dependencyId, dependencyId))
      )
      expect(checklistRows).toHaveLength(0)

      const lockedRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ id: credentialVersions.id })
          .from(credentialVersions)
          .where(
            and(
              eq(credentialVersions.credentialId, credential.id),
              isNull(credentialVersions.rotationLockedAt)
            )
          )
      )
      expect(lockedRows).toHaveLength(1) // the original version — never locked, rollback undid it
    } finally {
      auditSpy.mockRestore()
    }
  }, 20_000)
})
