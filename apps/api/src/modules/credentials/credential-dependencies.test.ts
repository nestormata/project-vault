import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { auditLogEntries, credentialDependencies, credentials } from '@project-vault/db/schema'
import { MAX_ACTIVE_DEPENDENCIES } from './schema.js'
import {
  addCredentialDependencyViaApi,
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
  credentialDependenciesUrl,
  credentialHasDependencies,
  credentialLifecycleUrl,
  listCredentialsViaApi,
  SENTINEL_VALUE,
} from './credential-route-test-helpers.js'
import {
  assertRoutesFailClosedWhileSealed,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createApp,
  createDirectAuthenticatedUser,
  CREDENTIAL_INTEGRATION_LOGIN_SECRET as PASSWORD,
  FORCED_AUDIT_FAILURE,
  humanAudit,
  initVault,
  loginExistingUserInOrg,
  MONTHLY_ROTATION_CRON,
  resetVaultForTest,
  type CredentialRegisteredUser as RegisteredUser,
  type CredentialTestApp as TestApp,
} from './credential-integration-context.js'

const TEST_PASSPHRASE = 'credential-deps-passphrase'
const FUTURE_EXPIRY = '2026-12-31T23:59:59.000Z'
const AWS_SSM_PARAMETERS_URL = 'https://console.aws.amazon.com/systems-manager/parameters'

describe.sequential('credential dependencies and lifecycle routes', () => {
  let app: TestApp
  let owner: RegisteredUser
  let other: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner, other } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'deps'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('POST dependency creates a row with audit and defaults systemType to other', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'add-dep')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'billing-worker (prod)', notes: 'pipeline notes' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      data: {
        credentialId: credential.id,
        systemName: 'billing-worker (prod)',
        systemType: 'other',
        archivedAt: null,
      },
    })
    expect(JSON.stringify(res.json())).not.toContain(SENTINEL_VALUE)

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.dependency_added'))
    )
    expect(
      auditRows.some(
        (row) =>
          row.resourceId === credential.id &&
          (row.payload as { systemType?: string }).systemType === 'other'
      )
    ).toBe(true)
  }, 20_000)

  it('POST allows duplicate systemName rows and enforces the active dependency cap', async () => {
    const projectId = await insertTestProject(owner.orgId, {
      userId: owner.userId,
      slug: 'dep-cap',
    }).then((p) => p.id)
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const first = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'shared-name' },
    })
    const second = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'shared-name' },
    })
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)

    await withOrg(owner.orgId, async (tx) => {
      const existing = await tx
        .select({ id: credentialDependencies.id })
        .from(credentialDependencies)
        .where(
          and(
            eq(credentialDependencies.credentialId, credential.id),
            isNull(credentialDependencies.archivedAt)
          )
        )
      const toInsert = MAX_ACTIVE_DEPENDENCIES - existing.length
      if (toInsert > 0) {
        await tx.insert(credentialDependencies).values(
          Array.from({ length: toInsert }, (_, i) => ({
            orgId: owner.orgId,
            credentialId: credential.id,
            systemName: `bulk-${i}`,
            createdBy: owner.userId,
          }))
        )
      }
    })

    const capped = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'one-too-many' },
    })
    expect(capped.statusCode).toBe(422)
    expect(capped.json()).toMatchObject({ code: 'too_many_dependencies' })
  }, 30_000)

  it('GET lists active dependencies, supports includeArchived, and tracks hasDependencies', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'list-dep')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const created = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      { systemName: 'active-service', systemType: 'service' }
    )
    const dependencyId = created.json<{ data: { id: string } }>().data.id

    const active = await app.inject({
      method: 'GET',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(active.statusCode, JSON.stringify(active.json())).toBe(200)
    expect(active.json()).toMatchObject({
      data: { hasDependencies: true, items: [expect.objectContaining({ id: dependencyId })] },
    })

    await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    const archivedOnly = await app.inject({
      method: 'GET',
      url: `${credentialDependenciesUrl(projectId, credential.id)}?includeArchived=true`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(
      archivedOnly.json<{
        data: { hasDependencies: boolean; items: { archivedAt: string | null }[] }
      }>().data
    ).toMatchObject({
      hasDependencies: false,
      items: [expect.objectContaining({ archivedAt: expect.any(String) })],
    })

    const excludeArchived = await app.inject({
      method: 'GET',
      url: `${credentialDependenciesUrl(projectId, credential.id)}?includeArchived=false`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(excludeArchived.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(0)
  }, 20_000)

  it('DELETE soft-archives idempotently and rolls back on audit failure', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'archive-dep')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const created = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'to-archive' },
    })
    const dependencyId = created.json<{ data: { id: string } }>().data.id

    const archived = await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(archived.statusCode).toBe(200)
    const archivedAt = archived.json<{ data: { archivedAt: string } }>().data.archivedAt

    const again = await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(again.statusCode).toBe(200)
    expect(again.json<{ data: { archivedAt: string } }>().data.archivedAt).toBe(archivedAt)

    const fresh = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'audit-fail-dep' },
    })
    const freshId = fresh.json<{ data: { id: string } }>().data.id
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const fail = await app.inject({
        method: 'DELETE',
        url: `${credentialDependenciesUrl(projectId, credential.id)}/${freshId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expectAuditWriteFailed(fail)
    } finally {
      auditSpy.mockRestore()
    }

    const row = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ archivedAt: credentialDependencies.archivedAt })
        .from(credentialDependencies)
        .where(eq(credentialDependencies.id, freshId))
        .limit(1)
    )
    expect(row[0]?.archivedAt).toBeNull()
  }, 20_000)

  it('POST accepts an optional http(s) linkUrl, trims it, and rejects invalid schemes/shapes', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'link-url')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const withLink = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        systemName: 'billing-worker-with-link (prod)',
        linkUrl: '  https://github.com/org/billing-worker/settings  ',
      },
    })
    expect(withLink.statusCode).toBe(201)
    expect(withLink.json<{ data: { linkUrl: string } }>().data.linkUrl).toBe(
      'https://github.com/org/billing-worker/settings'
    )

    const noLink = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'no-link-service' },
    })
    expect(noLink.statusCode).toBe(201)
    expect(noLink.json<{ data: { linkUrl: string | null } }>().data.linkUrl).toBeNull()

    const javascriptScheme = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'bad-scheme', linkUrl: 'javascript:alert(1)' },
    })
    expect(javascriptScheme.statusCode).toBe(422)
    expect(javascriptScheme.json()).toMatchObject({ code: 'invalid_link_url' })

    const relative = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'bad-shape', linkUrl: 'not-a-url' },
    })
    expect(relative.statusCode).toBe(422)
    expect(relative.json()).toMatchObject({ code: 'invalid_link_url' })

    const internalHost = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        systemName: 'internal-vault',
        linkUrl: 'https://vault.internal.corp:8443/secrets/billing',
      },
    })
    expect(internalHost.statusCode).toBe(201)

    const tooLong = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        systemName: 'too-long',
        linkUrl: `https://example.com/${'a'.repeat(2048)}`,
      },
    })
    expect(tooLong.statusCode).toBe(422)
  }, 20_000)

  // Code review finding (2-10): AC-3 requires trimming BEFORE length validation — a value that
  // trims to well under 2048 chars must not be rejected just because surrounding whitespace
  // pushes the raw (untrimmed) length over the limit.
  it('POST trims before enforcing the linkUrl 2048-char limit, not after', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'link-url-trim')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const padded = `${' '.repeat(30)}https://example.com/short${' '.repeat(2048)}`
    const res = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'padded-link', linkUrl: padded },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<{ data: { linkUrl: string } }>().data.linkUrl).toBe('https://example.com/short')
  }, 20_000)

  it('GET list includes linkUrl additively', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'link-list')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    await addCredentialDependencyViaApi(app, owner.cookies, projectId, credential.id, {
      systemName: 'listed-with-link',
      linkUrl: 'https://example.com/deploy',
    })

    const res = await app.inject({
      method: 'GET',
      url: credentialDependenciesUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { items: { linkUrl: string | null }[] } }>().data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ linkUrl: 'https://example.com/deploy' })])
    )
  }, 20_000)

  it('PATCH dependency sets/clears linkUrl, rejects no-op and archived edits, and audits before/after', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'link-patch')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const created = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'patchable-service',
      }
    )
    const dependencyId = created.json<{ data: { id: string } }>().data.id
    const patchUrl = `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`

    const setLink = await app.inject({
      method: 'PATCH',
      url: patchUrl,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { linkUrl: AWS_SSM_PARAMETERS_URL },
    })
    expect(setLink.statusCode).toBe(200)
    expect(setLink.json<{ data: { linkUrl: string } }>().data.linkUrl).toBe(AWS_SSM_PARAMETERS_URL)

    const clearLink = await app.inject({
      method: 'PATCH',
      url: patchUrl,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { linkUrl: null },
    })
    expect(clearLink.statusCode).toBe(200)
    expect(clearLink.json<{ data: { linkUrl: string | null } }>().data.linkUrl).toBeNull()

    const empty = await app.inject({
      method: 'PATCH',
      url: patchUrl,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {},
    })
    expect(empty.statusCode).toBe(422)
    expect(empty.json()).toMatchObject({ code: 'no_fields_to_update' })

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.dependency_updated'))
    )
    const setRow = auditRows.find(
      (row) =>
        row.resourceId === credential.id &&
        (row.payload as { linkUrl?: string }).linkUrl === AWS_SSM_PARAMETERS_URL
    )
    expect(setRow).toBeDefined()
    expect((setRow?.payload as { previousLinkUrl?: string | null }).previousLinkUrl).toBeNull()
    const clearRow = auditRows.find(
      (row) =>
        row.resourceId === credential.id && (row.payload as { linkUrl?: null }).linkUrl === null
    )
    expect(clearRow).toBeDefined()
    expect((clearRow?.payload as { previousLinkUrl?: string | null }).previousLinkUrl).toBe(
      AWS_SSM_PARAMETERS_URL
    )

    // Example 3c: PATCH on an already-archived dependency → dependency_not_found, not a distinct code.
    await app.inject({
      method: 'DELETE',
      url: patchUrl,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    const patchArchived = await app.inject({
      method: 'PATCH',
      url: patchUrl,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { linkUrl: 'https://example.com/new' },
    })
    expect(patchArchived.statusCode).toBe(404)
    expect(patchArchived.json()).toMatchObject({ code: 'dependency_not_found' })

    // Cross-org / viewer / missing-dependency
    const crossOrgPatch = await app.inject({
      method: 'PATCH',
      url: `${credentialDependenciesUrl(projectId, randomUUID())}/${randomUUID()}`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { linkUrl: 'https://example.com/x' },
    })
    expect(crossOrgPatch.statusCode).toBe(404)

    const viewer = await createDirectAuthenticatedUser(app, 'link-patch-viewer', 'viewer')
    const created2 = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'viewer-denied-target',
      }
    )
    const dependency2Id = created2.json<{ data: { id: string } }>().data.id
    const viewerDenied = await app.inject({
      method: 'PATCH',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependency2Id}`,
      headers: { cookie: cookieHeader(viewer.cookies) },
      payload: { linkUrl: 'https://example.com/x' },
    })
    expect(viewerDenied.statusCode).toBe(403)
  }, 30_000)

  it('rolls back PATCH dependency linkUrl when audit write fails', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'link-patch-rollback')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const created = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'rollback-target',
      }
    )
    const dependencyId = created.json<{ data: { id: string } }>().data.id

    const patchSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const fail = await app.inject({
        method: 'PATCH',
        url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { linkUrl: 'https://example.com/rollback' },
      })
      expectAuditWriteFailed(fail)
    } finally {
      patchSpy.mockRestore()
    }

    const row = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ linkUrl: credentialDependencies.linkUrl })
        .from(credentialDependencies)
        .where(eq(credentialDependencies.id, dependencyId))
    )
    expect(row[0]?.linkUrl).toBeNull()
  }, 20_000)

  it('PATCH lifecycle supports partial updates, clears fields, and validates cron', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'lifecycle')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Lifecycle Key',
      value: 'secret',
      rotationSchedule: MONTHLY_ROTATION_CRON,
    })

    const both = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        expiresAt: FUTURE_EXPIRY,
        rotationSchedule: MONTHLY_ROTATION_CRON,
      },
    })
    expect(both.statusCode).toBe(200)

    const partial = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { expiresAt: '2020-01-01T00:00:00.000Z' },
    })
    expect(partial.statusCode).toBe(200)
    expect(partial.json<{ data: { rotationSchedule: string } }>().data.rotationSchedule).toBe(
      MONTHLY_ROTATION_CRON
    )

    const clear = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { rotationSchedule: null },
    })
    expect(
      clear.json<{ data: { rotationSchedule: string | null } }>().data.rotationSchedule
    ).toBeNull()

    const empty = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {},
    })
    expect(empty.statusCode).toBe(422)
    expect(empty.json()).toMatchObject({ code: 'no_fields_to_update' })

    const tooFrequent = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { rotationSchedule: '*/30 * * * *' },
    })
    expect(tooFrequent.statusCode).toBe(422)
    expect(tooFrequent.json()).toMatchObject({
      code: 'invalid_cron',
      message: 'Rotation schedule may run at most once per hour',
    })

    const impossible = await app.inject({
      method: 'PATCH',
      url: credentialLifecycleUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { rotationSchedule: '0 0 30 2 *' },
    })
    expect(impossible.statusCode).toBe(422)
    expect(impossible.json()).toMatchObject({ code: 'invalid_cron' })
  }, 20_000)

  it('GET access lists active org members for admin/owner only', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'access-list')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    const foreignUser = await createDirectAuthenticatedUser(app, 'foreign-member', 'member')
    const sameOrgMemberCookies = await loginExistingUserInOrg(app, {
      userId: foreignUser.userId,
      orgId: owner.orgId,
      role: 'member',
    })

    const ownerRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}/access`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(ownerRes.statusCode).toBe(200)
    expect(
      ownerRes.json<{ data: { items: { identityType: string; displayName: string }[] } }>().data
        .items
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ identityType: 'user', displayName: expect.any(String) }),
      ])
    )

    const memberDenied = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}/access`,
      headers: { cookie: cookieHeader(sameOrgMemberCookies) },
    })
    expect(memberDenied.statusCode).toBe(403)

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/credentials/${randomUUID()}/access`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json()).toMatchObject({ code: 'credential_not_found' })
  }, 20_000)

  it('rolls back POST dependency and PATCH lifecycle when audit write fails', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'audit-rollback')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const addSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const addFail = await app.inject({
        method: 'POST',
        url: credentialDependenciesUrl(projectId, credential.id),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { systemName: 'audit-rollback-add' },
      })
      expectAuditWriteFailed(addFail)
    } finally {
      addSpy.mockRestore()
    }

    const afterAddFail = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: credentialDependencies.id })
        .from(credentialDependencies)
        .where(eq(credentialDependencies.systemName, 'audit-rollback-add'))
    )
    expect(afterAddFail).toHaveLength(0)

    const patchSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const patchFail = await app.inject({
        method: 'PATCH',
        url: credentialLifecycleUrl(projectId, credential.id),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { expiresAt: FUTURE_EXPIRY },
      })
      expectAuditWriteFailed(patchFail)
    } finally {
      patchSpy.mockRestore()
    }

    const afterPatchFail = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ expiresAt: credentials.expiresAt })
        .from(credentials)
        .where(eq(credentials.id, credential.id))
    )
    expect(afterPatchFail[0]?.expiresAt).toBeNull()
  }, 20_000)

  it('PATCH lifecycle skips audit when values are unchanged', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'lifecycle-noop')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'No-op Lifecycle',
      value: 'secret',
      rotationSchedule: MONTHLY_ROTATION_CRON,
    })

    const auditSpy = vi.spyOn(humanAudit, 'writeHumanAuditEntry')
    try {
      const noop = await app.inject({
        method: 'PATCH',
        url: credentialLifecycleUrl(projectId, credential.id),
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { rotationSchedule: MONTHLY_ROTATION_CRON },
      })
      expect(noop.statusCode).toBe(200)
      expect(
        auditSpy.mock.calls.filter((call) => call[1]?.eventType === 'credential.lifecycle_updated')
      ).toHaveLength(0)
    } finally {
      auditSpy.mockRestore()
    }
  }, 20_000)

  it('DELETE returns credential_not_found when the parent credential is missing', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'delete-missing-cred')
    const missing = await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, randomUUID())}/${randomUUID()}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'credential_not_found' })
  }, 20_000)

  it('returns 404 for cross-org credential access and denies viewer mutations', async () => {
    const otherProjectId = await createCredentialTestProject(app, other.cookies, 'foreign')
    const ownerProjectId = await createCredentialTestProject(app, owner.cookies, 'owner-proj')
    const credential = await createCredentialViaApi(app, owner.cookies, ownerProjectId)
    const viewer = await createDirectAuthenticatedUser(app, 'viewer', 'viewer')

    const crossOrg = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(otherProjectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'foreign' },
    })
    expect(crossOrg.statusCode).toBe(404)

    const viewerDenied = await app.inject({
      method: 'POST',
      url: credentialDependenciesUrl(ownerProjectId, credential.id),
      headers: { cookie: cookieHeader(viewer.cookies) },
      payload: { systemName: 'denied' },
    })
    expect(viewerDenied.statusCode).toBe(403)
  }, 20_000)

  it('hasDependencies on credential list tracks active dependencies', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'has-deps-flag')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const before = await listCredentialsViaApi(app, owner.cookies, projectId)
    expect(credentialHasDependencies(before, credential.id)).toBe(false)

    const created = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      {
        systemName: 'listed-dep',
      }
    )
    const dependencyId = created.json<{ data: { id: string } }>().data.id

    const afterAdd = await listCredentialsViaApi(app, owner.cookies, projectId)
    expect(credentialHasDependencies(afterAdd, credential.id)).toBe(true)

    await app.inject({
      method: 'DELETE',
      url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyId}`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })

    const afterArchive = await listCredentialsViaApi(app, owner.cookies, projectId)
    expect(credentialHasDependencies(afterArchive, credential.id)).toBe(false)
  }, 20_000)

  it('never leaks credential values across dependency and lifecycle endpoints', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'no-leak')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Leak Test',
      value: SENTINEL_VALUE,
    })
    const dependencyForPatch = await addCredentialDependencyViaApi(
      app,
      owner.cookies,
      projectId,
      credential.id,
      { systemName: 'leak-check-dep' }
    )
    const dependencyForPatchId = dependencyForPatch.json<{ data: { id: string } }>().data.id

    const endpoints = [
      {
        method: 'POST' as const,
        url: credentialDependenciesUrl(projectId, credential.id),
        payload: { systemName: 'svc' },
      },
      { method: 'GET' as const, url: credentialDependenciesUrl(projectId, credential.id) },
      {
        method: 'PATCH' as const,
        url: `${credentialDependenciesUrl(projectId, credential.id)}/${dependencyForPatchId}`,
        payload: { linkUrl: 'https://example.com/leak-check' },
      },
      {
        method: 'PATCH' as const,
        url: credentialLifecycleUrl(projectId, credential.id),
        payload: { expiresAt: FUTURE_EXPIRY },
      },
      {
        method: 'GET' as const,
        url: `/api/v1/projects/${projectId}/credentials/${credential.id}/access`,
      },
      { method: 'GET' as const, url: `/api/v1/projects/${projectId}/credentials` },
    ]

    for (const request of endpoints) {
      const res = await app.inject({
        ...request,
        headers: { cookie: cookieHeader(owner.cookies) },
      })
      expect(JSON.stringify(res.json())).not.toContain(SENTINEL_VALUE)
    }
  }, 20_000)

  it('dependency and lifecycle routes fail closed while the vault is sealed', async () => {
    const projectId = randomUUID()
    const credentialId = randomUUID()
    const dependencyId = randomUUID()
    app = await assertRoutesFailClosedWhileSealed(
      app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        {
          method: 'POST',
          url: credentialDependenciesUrl(projectId, credentialId),
          payload: { systemName: 'sealed' },
        },
        { method: 'GET', url: credentialDependenciesUrl(projectId, credentialId) },
        {
          method: 'DELETE',
          url: `${credentialDependenciesUrl(projectId, credentialId)}/${dependencyId}`,
        },
        {
          method: 'PATCH',
          url: `${credentialDependenciesUrl(projectId, credentialId)}/${dependencyId}`,
          payload: { linkUrl: 'https://example.com/sealed' },
        },
        {
          method: 'PATCH',
          url: `/api/v1/projects/${projectId}/credentials/${credentialId}`,
          payload: { expiresAt: FUTURE_EXPIRY },
        },
        {
          method: 'GET',
          url: `/api/v1/projects/${projectId}/credentials/${credentialId}/access`,
        },
      ]
    )

    await app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)
})
