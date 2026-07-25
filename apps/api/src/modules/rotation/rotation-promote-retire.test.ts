import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialVersions, rotations } from '@project-vault/db/schema'
import {
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import { cookieHeader } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createApp,
  createDirectAuthenticatedUser,
  initVault,
  loginExistingUserInOrg,
  resetVaultForTest,
  ROTATION_INTEGRATION_LOGIN_SECRET as PASSWORD,
  type RotationRegisteredUser as RegisteredUser,
  type RotationTestApp as TestApp,
} from './rotation-integration-context.js'

const TEST_PASSPHRASE = 'rotation-promote-retire-passphrase'
const PROMOTE_HAPPY_NEW_VALUE = 'new-value-x'

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

async function promoteViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  ids: { projectId: string; credentialId: string; rotationId: string },
  body: Record<string, unknown> = {}
) {
  return app.inject({
    method: 'POST',
    url: `${rotationsUrl(ids.projectId, ids.credentialId)}/${ids.rotationId}/promote`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function retireViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  ids: { projectId: string; credentialId: string; rotationId: string },
  body: Record<string, unknown> = {}
) {
  return app.inject({
    method: 'POST',
    url: `${rotationsUrl(ids.projectId, ids.credentialId)}/${ids.rotationId}/retire`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
}

async function stagedValueViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  ids: { projectId: string; credentialId: string; rotationId: string }
) {
  return app.inject({
    method: 'GET',
    url: `${rotationsUrl(ids.projectId, ids.credentialId)}/${ids.rotationId}/staged-value`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function initiateAndGetIds(
  app: TestApp,
  cookies: Record<string, string>,
  slug: string,
  newValue = `rotated-${randomUUID()}`
) {
  const projectId = await createCredentialTestProject(app, cookies, slug)
  const credential = await createCredentialViaApi(app, cookies, projectId)
  const initiate = await initiateRotationViaApi(app, cookies, projectId, credential.id, {
    newValue,
  })
  expect(initiate.statusCode).toBe(201)
  const rotationId = initiate.json<{ data: { id: string } }>().data.id
  return { projectId, credentialId: credential.id, rotationId }
}

describe.sequential('rotation promote/retire/staged-value routes (Story 5.6)', () => {
  let app: TestApp
  let owner: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'promote-retire'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('AC-6a: promote with pending checklist items requires acknowledgement, then succeeds when acknowledged', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'promote-ack')

    const withoutAck = await promoteViaApi(app, owner.cookies, ids)
    // Zero checklist items on a bare credential — the existing acknowledgedNoDependencies gate.
    expect(withoutAck.statusCode).toBe(422)
    expect(withoutAck.json()).toMatchObject({ code: 'acknowledgement_required' })

    const withAck = await promoteViaApi(app, owner.cookies, ids, {
      acknowledgedNoDependencies: true,
    })
    expect(withAck.statusCode).toBe(200)
    expect(withAck.json()).toMatchObject({ data: { status: 'promoted' } })

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'rotation.promoted'))
    )
    expect(
      auditRows.some(
        (row) =>
          (row.payload as { checklistAcknowledged?: boolean }).checklistAcknowledged === false
      )
    ).toBe(true)
  })

  it('AC-1 Example 1b + AC-2/AC-6b: happy path — staged keeps old value current, promote flips it, retire purges the old version', async () => {
    const ids = await initiateAndGetIds(
      app,
      owner.cookies,
      'promote-retire-happy',
      PROMOTE_HAPPY_NEW_VALUE
    )

    // Still staged: old (sentinel) value is current.
    const beforePromote = await app.inject({
      method: 'GET',
      url: credentialValueUrl(ids.projectId, ids.credentialId),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(beforePromote.json<{ data: { value: string } }>().data.value).not.toBe(
      PROMOTE_HAPPY_NEW_VALUE
    )

    const promoteRes = await promoteViaApi(app, owner.cookies, ids, {
      acknowledgedNoDependencies: true,
    })
    expect(promoteRes.statusCode).toBe(200)
    expect(promoteRes.json()).toMatchObject({ data: { status: 'promoted' } })

    const afterPromote = await app.inject({
      method: 'GET',
      url: credentialValueUrl(ids.projectId, ids.credentialId),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(afterPromote.json<{ data: { value: string } }>().data.value).toBe(
      PROMOTE_HAPPY_NEW_VALUE
    )

    const retireRes = await retireViaApi(app, owner.cookies, ids, {
      acknowledgedNoDependencies: true,
    })
    expect(retireRes.statusCode).toBe(200)
    expect(retireRes.json()).toMatchObject({ data: { status: 'retired' } })

    const rotationRow = await withOrg(owner.orgId, (tx) =>
      tx.select().from(rotations).where(eq(rotations.id, ids.rotationId))
    )
    const previousVersionId = rotationRow[0]?.previousVersionId
    const oldVersion = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          purgedAt: credentialVersions.purgedAt,
          encryptedValue: credentialVersions.encryptedValue,
          rotationLockedAt: credentialVersions.rotationLockedAt,
        })
        .from(credentialVersions)
        .where(eq(credentialVersions.id, previousVersionId as string))
    )
    expect(oldVersion[0]?.purgedAt).not.toBeNull()
    expect(oldVersion[0]?.encryptedValue).toBeNull()
    expect(oldVersion[0]?.rotationLockedAt).toBeNull()
  })

  it('AC-2 Example 2b/2a: promote and retire re-attempts against the wrong status return their own 409 codes', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'promote-retire-wrong-state')
    await promoteViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true })

    const secondPromote = await promoteViaApi(app, owner.cookies, ids, {
      acknowledgedNoDependencies: true,
    })
    expect(secondPromote.statusCode).toBe(409)
    expect(secondPromote.json()).toMatchObject({
      code: 'rotation_not_promotable',
      currentStatus: 'promoted',
    })

    await retireViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true })
    const secondRetire = await retireViaApi(app, owner.cookies, ids, {
      acknowledgedNoDependencies: true,
    })
    expect(secondRetire.statusCode).toBe(409)
    expect(secondRetire.json()).toMatchObject({
      code: 'rotation_not_retirable',
      currentStatus: 'retired',
    })
  })

  it('AC-5.2/5.3: two concurrent promote calls — exactly one 200, one 409, exactly one audit row', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'promote-race')

    const [first, second] = await Promise.all([
      promoteViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true }),
      promoteViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true }),
    ])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 409])

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ resourceId: auditLogEntries.resourceId, payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'rotation.promoted'))
    )
    const matching = auditRows.filter((row) => row.resourceId === ids.rotationId)
    expect(matching).toHaveLength(1)
  })

  it('AC-5.3: two concurrent retire calls — exactly one 200, one 409, exactly one cryptographic purge', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'retire-race')
    await promoteViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true })

    const [first, second] = await Promise.all([
      retireViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true }),
      retireViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true }),
    ])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 409])

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'rotation.old_retired'))
    )
    expect(auditRows.filter((row) => row.resourceId === ids.rotationId)).toHaveLength(1)
  })

  it('AC-8: staged-value is independently retrievable while staged, 404s once promoted, and audits STAGED_VALUE_REVEALED', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'staged-value', 'the-staged-value')

    const revealRes = await stagedValueViaApi(app, owner.cookies, ids)
    expect(revealRes.statusCode).toBe(200)
    expect(revealRes.json<{ data: { value: string } }>().data.value).toBe('the-staged-value')

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'rotation.staged_value_revealed'))
    )
    expect(auditRows.some((row) => row.resourceId === ids.rotationId)).toBe(true)

    await promoteViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true })
    const afterPromote = await stagedValueViaApi(app, owner.cookies, ids)
    expect(afterPromote.statusCode).toBe(404)
  })

  it('AC-8 Example 8a: cross-org staged-value reveal returns tenant-scoped 404, not 403', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'staged-value-cross-org')
    const otherOrgUser = await createDirectAuthenticatedUser(app, 'staged-value-other-org', 'admin')

    const res = await stagedValueViaApi(app, otherOrgUser.cookies, ids)
    expect(res.statusCode).toBe(404)
  })

  it('AC-8.1: viewer role cannot reveal a staged value (same gate as ordinary reveal)', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'staged-value-viewer')
    const viewer = await createDirectAuthenticatedUser(app, 'staged-value-viewer-role', 'viewer')
    const sameOrgViewerCookies = await loginExistingUserInOrg(app, {
      userId: viewer.userId,
      orgId: owner.orgId,
      role: 'viewer',
    })

    const res = await stagedValueViaApi(app, sameOrgViewerCookies, ids)
    expect(res.statusCode).toBe(403)
  })

  it('AC-10/Example 10a: archiving a project with a staged or promoted rotation is blocked', async () => {
    const ids = await initiateAndGetIds(app, owner.cookies, 'archive-guard-staged')

    const archiveStagedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${ids.projectId}/archive`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(archiveStagedRes.statusCode).not.toBe(200)

    await promoteViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true })
    const archivePromotedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${ids.projectId}/archive`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(archivePromotedRes.statusCode).not.toBe(200)

    await retireViaApi(app, owner.cookies, ids, { acknowledgedNoDependencies: true })
    const archiveAfterRetireRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${ids.projectId}/archive`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(archiveAfterRetireRes.statusCode).toBe(200)
  })
})
