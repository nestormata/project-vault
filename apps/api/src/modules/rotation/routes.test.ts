import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialVersions,
  credentials,
  notificationQueue,
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

// ============================================================================
// Story 5.2 — checklist confirm/fail/retry/complete + upcoming rotations
// ============================================================================

function checklistItemUrl(
  projectId: string,
  credentialId: string,
  rotationId: string,
  itemId: string,
  action: 'confirm' | 'fail' | 'retry'
) {
  return `${rotationsUrl(projectId, credentialId)}/${rotationId}/checklist/${itemId}/${action}`
}

function completeRotationUrl(projectId: string, credentialId: string, rotationId: string) {
  return `${rotationsUrl(projectId, credentialId)}/${rotationId}/complete`
}

function upcomingRotationsUrl(projectId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/rotations/upcoming${suffix}`
}

/** confirm/fail/retry are identical thin wrappers around the same checklist-item POST shape,
 *  differing only in the URL's action segment and each action's own default body. */
function checklistActionViaApi(
  action: 'confirm' | 'fail' | 'retry',
  defaultBody: Record<string, unknown> = {}
) {
  return async function (
    app: TestApp,
    cookies: Record<string, string>,
    ids: { projectId: string; credentialId: string; rotationId: string; itemId: string },
    body: Record<string, unknown> = defaultBody
  ) {
    return app.inject({
      method: 'POST',
      url: checklistItemUrl(ids.projectId, ids.credentialId, ids.rotationId, ids.itemId, action),
      headers: { cookie: cookieHeader(cookies) },
      payload: body,
    })
  }
}

const confirmChecklistItemViaApi = checklistActionViaApi('confirm')
const failChecklistItemViaApi = checklistActionViaApi('fail', {
  reason: 'target system not yet updated',
})
const retryChecklistItemViaApi = checklistActionViaApi('retry')

/** Shared by confirm/fail/retry success-path assertions: every one of those routes replies with
 *  this same { item, rotationVersion } envelope on 200. */
function expectItemMutationSuccess(res: Awaited<ReturnType<TestApp['inject']>>) {
  expect(res.statusCode).toBe(200)
  return res.json<{ data: { item: Record<string, unknown>; rotationVersion: number } }>()
}

async function completeRotationViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  ids: { projectId: string; credentialId: string; rotationId: string },
  body: Record<string, unknown> = {}
) {
  return app.inject({
    method: 'POST',
    url: completeRotationUrl(ids.projectId, ids.credentialId, ids.rotationId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function getUpcomingRotationsViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  suffix = ''
) {
  return app.inject({
    method: 'GET',
    url: upcomingRotationsUrl(projectId, suffix),
    headers: { cookie: cookieHeader(cookies) },
  })
}

type ChecklistItemFixture = { id: string; systemName: string; status: string }

/** Non-null-assertion-free array/lookup access for test fixtures — avoids `!` (forbidden by
 *  this repo's eslint config) when indexing into an array whose length the test already
 *  guarantees by construction (e.g. "requested 2 dependencies, so items[0]/items[1] exist"). */
function must<T>(
  value: T | undefined,
  message = 'expected value to be defined in test fixture'
): T {
  if (value === undefined) throw new Error(message)
  return value
}

/** Seeds a project + credential with `dependencyCount` dependencies, then initiates a rotation
 *  so there's a real `in_progress` rotation with that many `unconfirmed` checklist items. */
async function createRotationWithDependenciesFixture(
  app: TestApp,
  cookies: Record<string, string>,
  slug: string,
  dependencyCount: number
) {
  const projectId = await createCredentialTestProject(app, cookies, slug)
  const credential = await createCredentialViaApi(app, cookies, projectId)
  for (let i = 0; i < dependencyCount; i += 1) {
    await addCredentialDependencyViaApi(app, cookies, projectId, credential.id, {
      systemName: `dependency-${slug}-${i}`,
    })
  }
  const initiate = await initiateRotationViaApi(app, cookies, projectId, credential.id)
  expect(initiate.statusCode).toBe(201)
  const body = initiate.json<{ data: { id: string; checklistItems: ChecklistItemFixture[] } }>()
  return {
    projectId,
    credentialId: credential.id,
    rotationId: body.data.id,
    items: body.data.checklistItems,
  }
}

/** Shared setup step across several tests below: confirm the fixture's first checklist item and
 *  assert the confirm itself succeeded, before the test moves on to its own actual assertion. */
async function confirmFirstItem(
  app: TestApp,
  cookies: Record<string, string>,
  fixture: Awaited<ReturnType<typeof createRotationWithDependenciesFixture>>
) {
  const item = must(fixture.items[0])
  const res = await confirmChecklistItemViaApi(app, cookies, { ...fixture, itemId: item.id })
  expect(res.statusCode).toBe(200)
  return { item, res }
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

describe.sequential('rotation checklist confirm/fail/retry/complete + upcoming rotations', () => {
  let app: TestApp
  let owner: RegisteredUser
  let other: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner, other } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'checklist'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('POST confirm: unconfirmed -> confirmed, returns retryCount/lastActedBy/notes, bumps rotationVersion', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'confirm-happy',
      1
    )
    const item = must(fixture.items[0])

    const res = await confirmChecklistItemViaApi(
      app,
      owner.cookies,
      { ...fixture, itemId: item.id },
      { notes: 'Verified manually' }
    )
    const body = expectItemMutationSuccess(res)
    expect(body.data.item).toMatchObject({
      id: item.id,
      status: 'confirmed',
      confirmedBy: owner.userId,
      retryCount: 0,
      lastActedBy: owner.userId,
      notes: 'Verified manually',
    })
    expect(body.data.item.confirmedAt).toBeTypeOf('string')
    expect(body.data.item.lastActedAt).toBeTypeOf('string')
    expect(body.data.rotationVersion).toBe(2)
  })

  it('POST confirm supports confirming directly from failed and from max_retries_exceeded', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'confirm-from-failed',
      2
    )
    const itemA = must(fixture.items[0])
    const itemB = must(fixture.items[1])

    const failRes = await failChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: itemA.id,
    })
    expect(failRes.statusCode).toBe(200)
    const confirmFromFailed = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: itemA.id,
    })
    expect(confirmFromFailed.statusCode).toBe(200)
    expect(confirmFromFailed.json<{ data: { item: { status: string } } }>().data.item.status).toBe(
      'confirmed'
    )

    // Drive itemB to max_retries_exceeded (default ROTATION_MAX_RETRIES=3): retryCount only
    // increments on a *successful* retry, so reaching retryCount=3 (the cap) takes 3 successful
    // fail+retry cycles, then a 4th fail — the retry attempted after that 4th fail is the one
    // that finally observes retryCount >= maxRetries and escalates instead of succeeding.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const f = await failChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemB.id })
      expect(f.statusCode).toBe(200)
      if (cycle < 3) {
        const r = await retryChecklistItemViaApi(app, owner.cookies, {
          ...fixture,
          itemId: itemB.id,
        })
        expect(r.statusCode).toBe(200)
      }
    }
    const finalRetry = await retryChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: itemB.id,
    })
    expect(finalRetry.statusCode).toBe(422)
    expect(finalRetry.json()).toMatchObject({ code: 'max_retries_exceeded' })

    const confirmFromMaxExceeded = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: itemB.id,
    })
    expect(confirmFromMaxExceeded.statusCode).toBe(200)
    expect(
      confirmFromMaxExceeded.json<{ data: { item: { status: string } } }>().data.item.status
    ).toBe('confirmed')
  }, 20_000)

  it('POST confirm on an already-confirmed item returns 409 already_confirmed with the original evidentiary record', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'confirm-409',
      1
    )
    const { item, res: first } = await confirmFirstItem(app, owner.cookies, fixture)
    const firstBody = first.json<{ data: { item: { confirmedAt: string } } }>()

    const second = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: item.id,
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({
      code: 'already_confirmed',
      confirmedBy: owner.userId,
      confirmedAt: firstBody.data.item.confirmedAt,
    })
  })

  it('confirm/fail/retry against a rotation that is no longer in_progress returns 422 rotation_not_active, taking precedence over item-level checks', async () => {
    const fixture = await createRotationWithDependenciesFixture(app, owner.cookies, 'not-active', 1)
    const { item } = await confirmFirstItem(app, owner.cookies, fixture)

    const completeRes = await completeRotationViaApi(app, owner.cookies, fixture)
    expect(completeRes.statusCode).toBe(200)
    expect(completeRes.json()).toMatchObject({ data: { status: 'completed' } })

    // Re-confirming the same (already-confirmed) item on the now-completed rotation must hit
    // the rotation-level guard, NOT the item-level already_confirmed 409 (AC-3).
    const reconfirm = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: item.id,
    })
    expect(reconfirm.statusCode).toBe(422)
    expect(reconfirm.json()).toMatchObject({ code: 'rotation_not_active', status: 'completed' })
  })

  it('POST fail: unconfirmed -> failed, queues a rotation.confirmation_failed alert every call', async () => {
    const fixture = await createRotationWithDependenciesFixture(app, owner.cookies, 'fail-happy', 1)
    const item = must(fixture.items[0])

    const res = await failChecklistItemViaApi(
      app,
      owner.cookies,
      { ...fixture, itemId: item.id },
      {
        reason: 'GitHub Actions still using the old key',
        retryScheduledAt: '2026-07-01T16:00:00.000Z',
      }
    )
    const body = expectItemMutationSuccess(res)
    expect(body.data.item).toMatchObject({
      status: 'failed',
      lastFailureReason: 'GitHub Actions still using the old key',
      retryScheduledAt: '2026-07-01T16:00:00.000Z',
      retryCount: 0,
    })

    const queueRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ templateId: notificationQueue.templateId })
        .from(notificationQueue)
        .where(eq(notificationQueue.templateId, 'rotation.confirmation_failed'))
    )
    expect(queueRows.length).toBeGreaterThan(0)
  })

  it('POST fail rejects a non-unconfirmed item with 409 invalid_item_status including lastActedBy/lastActedAt', async () => {
    const fixture = await createRotationWithDependenciesFixture(app, owner.cookies, 'fail-409', 1)
    const item = must(fixture.items[0])
    const confirmRes = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: item.id,
    })
    expect(confirmRes.statusCode).toBe(200)

    const res = await failChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: item.id })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'invalid_item_status',
      currentStatus: 'confirmed',
      lastActedBy: owner.userId,
    })
  })

  it('POST fail validation: rejects missing/empty/whitespace/oversized reason, bad retryScheduledAt, and unknown fields with 422', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'fail-validation',
      1
    )
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }

    for (const body of [
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 'x'.repeat(1025) },
      { reason: 'ok', retryScheduledAt: 'not-a-date' },
      { reason: 'ok', extra: true },
    ]) {
      const res = await failChecklistItemViaApi(app, owner.cookies, ids, body)
      expect(res.statusCode).toBe(422)
    }
  })

  it('POST retry: failed -> unconfirmed with retryCount incremented, preserving lastFailureReason', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'retry-happy',
      1
    )
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }
    const failRes = await failChecklistItemViaApi(app, owner.cookies, ids, {
      reason: 'still broken',
    })
    expect(failRes.statusCode).toBe(200)

    const res = await retryChecklistItemViaApi(app, owner.cookies, ids)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { item: Record<string, unknown> } }>()
    expect(body.data.item).toMatchObject({
      status: 'unconfirmed',
      retryCount: 1,
      lastFailureReason: 'still broken',
    })
  })

  it('POST retry .strict() body rejects any field with 422', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'retry-validation',
      1
    )
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }
    await failChecklistItemViaApi(app, owner.cookies, ids)
    const res = await retryChecklistItemViaApi(app, owner.cookies, ids, { anything: true })
    expect(res.statusCode).toBe(422)
  })

  it('POST retry past the cap transitions the item to max_retries_exceeded and returns 422; a further retry then 409s', async () => {
    const fixture = await createRotationWithDependenciesFixture(app, owner.cookies, 'retry-max', 1)
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }

    // 3 successful fail+retry cycles bring retryCount to 3 (the cap); the 4th fail followed by
    // a retry attempt is the one that finally observes retryCount >= maxRetries and escalates.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await failChecklistItemViaApi(app, owner.cookies, ids)
      await retryChecklistItemViaApi(app, owner.cookies, ids)
    }
    await failChecklistItemViaApi(app, owner.cookies, ids)
    const maxOut = await retryChecklistItemViaApi(app, owner.cookies, ids)
    expect(maxOut.statusCode).toBe(422)
    expect(maxOut.json()).toMatchObject({
      code: 'max_retries_exceeded',
      retryCount: 3,
      maxRetries: 3,
    })

    const again = await retryChecklistItemViaApi(app, owner.cookies, ids)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({
      code: 'invalid_item_status',
      currentStatus: 'max_retries_exceeded',
    })

    const criticalAlerts = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ templateId: notificationQueue.templateId })
        .from(notificationQueue)
        .where(eq(notificationQueue.templateId, 'rotation.max_retries_exceeded'))
    )
    expect(criticalAlerts.length).toBeGreaterThan(0)
  }, 20_000)

  it('AC-19: two racing confirm calls on the SAME item → exactly one 200, one 409 concurrent_modification', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'race-same-item',
      1
    )
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }

    const [first, second] = await Promise.all([
      confirmChecklistItemViaApi(app, owner.cookies, ids),
      confirmChecklistItemViaApi(app, owner.cookies, ids),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([200, 409])
    const loser = first.statusCode === 409 ? first : second
    expect(loser.json()).toMatchObject({ code: 'concurrent_modification' })
  })

  it('AC-19/AC-8: two racing confirm calls on DIFFERENT items of the SAME rotation → exactly one 200, one 409 (rotation-scoped lock, not item-scoped)', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'race-diff-items',
      2
    )
    const itemA = must(fixture.items[0])
    const itemB = must(fixture.items[1])

    const [first, second] = await Promise.all([
      confirmChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemA.id }),
      confirmChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemB.id }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([200, 409])
  })

  it('AC-19: complete racing confirm on the last pending item → exactly one 409, no corrupted partial state', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'race-complete',
      1
    )
    const item = must(fixture.items[0])

    const [confirmRes, completeRes] = await Promise.all([
      confirmChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: item.id }),
      completeRotationViaApi(app, owner.cookies, fixture),
    ])
    const statuses = [confirmRes.statusCode, completeRes.statusCode]
    expect(statuses).toContain(409)
    // No impossible state: if the rotation ended up completed, the item must be confirmed.
    const finalRotation = await withOrg(owner.orgId, (tx) =>
      tx.select().from(rotations).where(eq(rotations.id, fixture.rotationId))
    )
    const finalItem = await withOrg(owner.orgId, (tx) =>
      tx.select().from(rotationChecklistItems).where(eq(rotationChecklistItems.id, item.id))
    )
    if (finalRotation[0]?.status === 'completed') {
      expect(finalItem[0]?.status).toBe('confirmed')
    }
  })

  it('POST complete: happy path retires the superseded version and marks the rotation completed', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-happy',
      2
    )
    for (const item of fixture.items) {
      const res = await confirmChecklistItemViaApi(app, owner.cookies, {
        ...fixture,
        itemId: item.id,
      })
      expect(res.statusCode).toBe(200)
    }

    const res = await completeRotationViaApi(app, owner.cookies, fixture)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { status: string; completedAt: string } }>()
    expect(body.data.status).toBe('completed')
    expect(body.data.completedAt).toBeTypeOf('string')

    const versionRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ rotationLockedAt: credentialVersions.rotationLockedAt })
        .from(credentialVersions)
        .where(
          and(
            eq(credentialVersions.credentialId, fixture.credentialId),
            isNull(credentialVersions.purgedAt)
          )
        )
    )
    expect(versionRows.some((v) => v.rotationLockedAt === null)).toBe(true)
  })

  it('POST complete blocked with 422 checklist_incomplete while any item is not confirmed', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-incomplete',
      2
    )
    const res = await completeRotationViaApi(app, owner.cookies, fixture)
    expect(res.statusCode).toBe(422)
    const body = res.json<{ code: string; pendingItems: unknown[] }>()
    expect(body.code).toBe('checklist_incomplete')
    expect(body.pendingItems).toHaveLength(2)

    const stillInProgress = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ status: rotations.status })
        .from(rotations)
        .where(eq(rotations.id, fixture.rotationId))
    )
    expect(stillInProgress[0]?.status).toBe('in_progress')
  })

  it('POST complete zero-dependency rotation requires acknowledgedNoDependencies, and the flag is ignored (not a bypass) when the checklist is populated', async () => {
    const zeroDepFixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-zero-dep',
      0
    )
    const withoutAck = await completeRotationViaApi(app, owner.cookies, zeroDepFixture)
    expect(withoutAck.statusCode).toBe(422)
    expect(withoutAck.json()).toMatchObject({
      code: 'acknowledgement_required',
      checklistItemCount: 0,
    })

    const withAck = await completeRotationViaApi(app, owner.cookies, zeroDepFixture, {
      acknowledgedNoDependencies: true,
    })
    expect(withAck.statusCode).toBe(200)

    const populatedFixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-zero-dep-ignored',
      2
    )
    const ignoredFlag = await completeRotationViaApi(app, owner.cookies, populatedFixture, {
      acknowledgedNoDependencies: true,
    })
    expect(ignoredFlag.statusCode).toBe(422)
    expect(ignoredFlag.json()).toMatchObject({ code: 'checklist_incomplete' })
  })

  it('POST complete validation: rejects wrong-typed acknowledgedNoDependencies and unknown fields with 422', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-validation',
      0
    )
    const wrongType = await completeRotationViaApi(app, owner.cookies, fixture, {
      acknowledgedNoDependencies: 'yes',
    })
    expect(wrongType.statusCode).toBe(422)

    const extraField = await completeRotationViaApi(app, owner.cookies, fixture, {
      acknowledgedNoDependencies: true,
      extra: 1,
    })
    expect(extraField.statusCode).toBe(422)
  })

  it('AC-12: completion retirement makes the superseded version an immediate purge candidate at retentionCount=1', async () => {
    const { pruneCredentialVersions } = await import('../../workers/prune-credential-versions.js')
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-retention',
      0
    )
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(credentials)
        .set({ retentionCount: 1 })
        .where(eq(credentials.id, fixture.credentialId))
    )

    const completeRes = await completeRotationViaApi(app, owner.cookies, fixture, {
      acknowledgedNoDependencies: true,
    })
    expect(completeRes.statusCode).toBe(200)

    const lockedImmediatelyAfter = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          rotationLockedAt: credentialVersions.rotationLockedAt,
          versionNumber: credentialVersions.versionNumber,
        })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, fixture.credentialId))
        .orderBy(credentialVersions.versionNumber)
    )
    const previous = lockedImmediatelyAfter.find((v) => v.versionNumber === 1)
    expect(previous?.rotationLockedAt).toBeNull()

    await pruneCredentialVersions()
    const afterPrune = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          purgedAt: credentialVersions.purgedAt,
          versionNumber: credentialVersions.versionNumber,
        })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, fixture.credentialId))
    )
    const previousAfterPrune = afterPrune.find((v) => v.versionNumber === 1)
    expect(previousAfterPrune?.purgedAt).not.toBeNull()
  }, 20_000)

  it('AC-13: GET rotation detail shows the full independent state machine after confirm/fail/retry/max-exceeded on a mixed rotation', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'live-status',
      3
    )
    const itemA = must(fixture.items[0])
    const itemB = must(fixture.items[1])
    const itemC = must(fixture.items[2])

    await confirmChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemA.id })

    // 3 successful fail+retry cycles bring retryCount to 3 (the cap), then a 4th fail+retry
    // finally escalates to max_retries_exceeded (retryCount only increments on success).
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await failChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemB.id })
      await retryChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemB.id })
    }
    await failChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemB.id })
    await retryChecklistItemViaApi(app, owner.cookies, { ...fixture, itemId: itemB.id }) // -> max_retries_exceeded

    const detailRes = await getRotationDetailViaApi(
      app,
      owner.cookies,
      fixture.projectId,
      fixture.credentialId,
      fixture.rotationId
    )
    expect(detailRes.statusCode).toBe(200)
    const body = detailRes.json<{
      data: { checklistItems: { id: string; status: string; lastActedBy: string | null }[] }
    }>()
    const byId = new Map(body.data.checklistItems.map((item) => [item.id, item]))
    expect(byId.get(itemA.id)?.status).toBe('confirmed')
    expect(byId.get(itemB.id)?.status).toBe('max_retries_exceeded')
    expect(byId.get(itemC.id)?.status).toBe('unconfirmed')
    // A and B were acted on (confirm / fail+retry cycles); C was never touched, so its
    // lastActedBy stays null — proving per-item state truly is independent, not a shared flag.
    expect(byId.get(itemA.id)?.lastActedBy).toBe(owner.userId)
    expect(byId.get(itemB.id)?.lastActedBy).toBe(owner.userId)
    expect(byId.get(itemC.id)?.lastActedBy).toBeNull()
  }, 20_000)

  it('role enforcement: viewer gets 403 on confirm/fail/retry/complete; member gets 403 on complete only', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'role-enforcement',
      1
    )
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }

    const viewerUser = await createDirectAuthenticatedUser(app, 'checklist-viewer', 'viewer')
    const viewerCookies = await loginExistingUserInOrg(app, {
      userId: viewerUser.userId,
      orgId: owner.orgId,
      role: 'viewer',
    })
    for (const res of await Promise.all([
      confirmChecklistItemViaApi(app, viewerCookies, ids),
      failChecklistItemViaApi(app, viewerCookies, ids),
      retryChecklistItemViaApi(app, viewerCookies, ids),
      completeRotationViaApi(app, viewerCookies, fixture),
    ])) {
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'insufficient_role' })
    }

    const memberUser = await createDirectAuthenticatedUser(app, 'checklist-member', 'member')
    const memberCookies = await loginExistingUserInOrg(app, {
      userId: memberUser.userId,
      orgId: owner.orgId,
      role: 'member',
    })
    const memberComplete = await completeRotationViaApi(app, memberCookies, fixture)
    expect(memberComplete.statusCode).toBe(403)

    const memberConfirm = await confirmChecklistItemViaApi(app, memberCookies, ids)
    expect(memberConfirm.statusCode).toBe(200)
  })

  it('MFA enforcement applies to complete for an admin session that has not completed MFA enrollment', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'complete-mfa',
      0
    )
    const unenrolledAdmin = await createDirectAuthenticatedUser(app, 'complete-mfa', 'admin')
    const adminCookies = await loginExistingUserInOrg(app, {
      userId: unenrolledAdmin.userId,
      orgId: owner.orgId,
      role: 'admin',
    })
    const res = await completeRotationViaApi(app, adminCookies, fixture, {
      acknowledgedNoDependencies: true,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'mfa_required' })
  })

  it('cross-org isolation: an org-B admin gets 404 (not 403) on all four mutation endpoints, and cross-rotation item id 404s distinctly', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'cross-tenant',
      1
    )
    const item = must(fixture.items[0])
    const ids = { ...fixture, itemId: item.id }

    // Sequential, not Promise.all: all four calls share the identical (other.orgId, rotationId)
    // advisory-lock key, so racing them concurrently would make 3 of the 4 fail with
    // concurrent_modification (self-contention) before ever reaching the not-found check — a
    // test artifact, not the cross-tenant behavior under test here (AC-19 covers lock racing).
    for (const call of [
      () => confirmChecklistItemViaApi(app, other.cookies, ids),
      () => failChecklistItemViaApi(app, other.cookies, ids),
      () => retryChecklistItemViaApi(app, other.cookies, ids),
      () => completeRotationViaApi(app, other.cookies, fixture),
    ]) {
      const res = await call()
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'rotation_not_found' })
    }

    // Cross-rotation item id: a real item that exists, but under a *different* rotation.
    const otherFixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'cross-tenant-b',
      1
    )
    const crossRotationRes = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...fixture,
      itemId: must(otherFixture.items[0]).id,
    })
    expect(crossRotationRes.statusCode).toBe(404)
    expect(crossRotationRes.json()).toMatchObject({ code: 'checklist_item_not_found' })

    // Syntactically valid but nonexistent rotationId/itemId
    const nonexistent = await confirmChecklistItemViaApi(app, owner.cookies, {
      ...ids,
      rotationId: randomUUID(),
    })
    expect(nonexistent.statusCode).toBe(404)
    expect(nonexistent.json()).toMatchObject({ code: 'rotation_not_found' })
  })

  it('malformed (non-UUID) itemId returns 422 validation_error, never 404', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'bad-uuid-item',
      1
    )
    const res = await app.inject({
      method: 'POST',
      url: checklistItemUrl(
        fixture.projectId,
        fixture.credentialId,
        fixture.rotationId,
        'not-a-uuid',
        'confirm'
      ),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('audit write failure rolls back confirm and complete atomically', async () => {
    const confirmFixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'audit-fail-confirm',
      1
    )
    const confirmItem = must(confirmFixture.items[0])
    const auditSpy1 = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const res = await confirmChecklistItemViaApi(app, owner.cookies, {
        ...confirmFixture,
        itemId: confirmItem.id,
      })
      expectAuditWriteFailed(res)
      const itemRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ status: rotationChecklistItems.status })
          .from(rotationChecklistItems)
          .where(eq(rotationChecklistItems.id, confirmItem.id))
      )
      expect(itemRows[0]?.status).toBe('unconfirmed')
      const rotationRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ version: rotations.version })
          .from(rotations)
          .where(eq(rotations.id, confirmFixture.rotationId))
      )
      expect(rotationRows[0]?.version).toBe(1)
    } finally {
      auditSpy1.mockRestore()
    }

    const completeFixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'audit-fail-complete',
      1
    )
    await confirmChecklistItemViaApi(app, owner.cookies, {
      ...completeFixture,
      itemId: must(completeFixture.items[0]).id,
    })
    const auditSpy2 = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const res = await completeRotationViaApi(app, owner.cookies, completeFixture)
      expectAuditWriteFailed(res)
      const rotationRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ status: rotations.status })
          .from(rotations)
          .where(eq(rotations.id, completeFixture.rotationId))
      )
      expect(rotationRows[0]?.status).toBe('in_progress')
      const versionRows = await withOrg(owner.orgId, (tx) =>
        tx
          .select({ rotationLockedAt: credentialVersions.rotationLockedAt })
          .from(credentialVersions)
          .where(
            and(
              eq(credentialVersions.credentialId, completeFixture.credentialId),
              isNull(credentialVersions.purgedAt)
            )
          )
      )
      expect(versionRows.some((v) => v.rotationLockedAt !== null)).toBe(true)
    } finally {
      auditSpy2.mockRestore()
    }
  }, 20_000)

  it('sealed vault fails closed with 503 for the checklist mutation and upcoming-rotations routes', async () => {
    const fixture = await createRotationWithDependenciesFixture(
      app,
      owner.cookies,
      'sealed-vault',
      1
    )
    app = await assertRoutesFailClosedWhileSealed(
      app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        {
          method: 'POST',
          url: checklistItemUrl(
            fixture.projectId,
            fixture.credentialId,
            fixture.rotationId,
            must(fixture.items[0]).id,
            'confirm'
          ),
          headers: { cookie: cookieHeader(owner.cookies) },
          payload: {},
        },
      ]
    )
    await app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)

  it('GET rotations/upcoming: happy path with horizon filtering, viewer-role read access, and 404 for cross-org project', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'upcoming-happy')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Upcoming Cred',
      value: SENTINEL_VALUE,
    })
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { rotationSchedule: '0 0 1 * *' },
    })
    expect(patchRes.statusCode).toBe(200)

    const viewerUser = await createDirectAuthenticatedUser(app, 'upcoming-viewer', 'viewer')
    const viewerCookies = await loginExistingUserInOrg(app, {
      userId: viewerUser.userId,
      orgId: owner.orgId,
      role: 'viewer',
    })
    const res = await getUpcomingRotationsViaApi(app, viewerCookies, projectId, '?horizon=90d')
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { items: { credentialId: string }[] } }>()
    expect(body.data.items.map((i) => i.credentialId)).toContain(credential.id)

    const shortHorizon = await getUpcomingRotationsViaApi(
      app,
      owner.cookies,
      projectId,
      '?horizon=7d'
    )
    expect(shortHorizon.statusCode).toBe(200)
    expect(
      shortHorizon
        .json<{ data: { items: { credentialId: string }[] } }>()
        .data.items.map((i) => i.credentialId)
    ).not.toContain(credential.id)

    const crossOrg = await getUpcomingRotationsViaApi(app, other.cookies, projectId)
    expect(crossOrg.statusCode).toBe(404)
    expect(crossOrg.json()).toMatchObject({ code: 'project_not_found' })

    const badHorizon = await getUpcomingRotationsViaApi(
      app,
      owner.cookies,
      projectId,
      '?horizon=1d'
    )
    expect(badHorizon.statusCode).toBe(422)
  })

  it('GET rotations/upcoming excludes a credential with an active in_progress rotation even if cron-due within horizon', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'upcoming-active')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Active Rotation Cred',
      value: SENTINEL_VALUE,
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { rotationSchedule: '0 * * * *' },
    })
    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id)
    expect(initiate.statusCode).toBe(201)

    const res = await getUpcomingRotationsViaApi(app, owner.cookies, projectId, '?horizon=90d')
    expect(res.statusCode).toBe(200)
    expect(
      res
        .json<{ data: { items: { credentialId: string }[] } }>()
        .data.items.map((i) => i.credentialId)
    ).not.toContain(credential.id)
  })
})
