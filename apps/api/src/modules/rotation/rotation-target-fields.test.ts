import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialDependencies,
  credentialVersions,
  rotations,
} from '@project-vault/db/schema'
import { encryptValue } from '../../lib/encrypt-value.js'
import {
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import { cookieHeader } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createApp,
  initVault,
  ROTATION_INTEGRATION_LOGIN_SECRET as PASSWORD,
  type RotationRegisteredUser as RegisteredUser,
  type RotationTestApp as TestApp,
} from './rotation-integration-context.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

function rotationsUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations${suffix}`
}

function credentialValueUrl(projectId: string, credentialId: string, field?: string) {
  const base = `/api/v1/projects/${projectId}/credentials/${credentialId}/value`
  return field ? `${base}?field=${encodeURIComponent(field)}` : base
}

async function initiateRotationViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  body: Record<string, unknown>
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

async function createMultiFieldCredential(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  name = `multi-${randomUUID()}`
) {
  return createCredentialViaApi(app, cookies, projectId, {
    name,
    fields: [
      { key: 'username', value: 'svc-1', sensitive: false },
      { key: 'password', value: 'old-pw', sensitive: true },
    ],
  } as unknown as { name: string; value: string; [key: string]: unknown })
}

describe.sequential('rotation target_fields — field-scoped rotation (Story 13.4)', () => {
  let app: TestApp
  let owner: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      'rotation-target-fields-passphrase',
      PASSWORD,
      'target-fields'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  // AC-2: rotations.target_fields records normalized targeted field keys; whole-secret leaves NULL
  it('AC-2: normalizes targetFields and stores them; whole-secret rotation leaves target_fields NULL', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac2-normalize')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['Password '],
    })
    expect(res.statusCode).toBe(201)
    const rotationId = res.json<{ data: { id: string; targetFields?: string[] | null } }>().data.id
    expect(res.json<{ data: { targetFields?: string[] | null } }>().data.targetFields).toEqual([
      'password',
    ])

    const row = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ targetFields: rotations.targetFields })
        .from(rotations)
        .where(eq(rotations.id, rotationId))
    )
    expect(row[0]?.targetFields).toEqual(['password'])

    // Second credential, whole-secret rotation — target_fields stays NULL.
    const credential2 = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: `legacy-${randomUUID()}`,
      value: 'sentinel',
    })
    const wholeRes = await initiateRotationViaApi(app, owner.cookies, projectId, credential2.id, {
      newValue: 'new-secret',
    })
    expect(wholeRes.statusCode).toBe(201)
    expect(
      wholeRes.json<{ data: { targetFields?: string[] | null } }>().data.targetFields
    ).toBeNull()
  })

  // AC-3: unknown target field key rejected atomically, before any write
  it('AC-3: rejects an unknown target field key with 400 unknown_field_key, zero side effects', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac3-unknown')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'x',
      targetFields: ['totp_secret'],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'unknown_field_key', field: 'totp_secret' })

    // Zero side effects: no rotations row for this credential.
    const rotationRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: rotations.id })
        .from(rotations)
        .where(eq(rotations.credentialId, credential.id))
    )
    expect(rotationRows).toHaveLength(0)

    // Partial validity is still a full rejection.
    const partial = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'x',
      targetFields: ['username', 'totp_secret'],
    })
    expect(partial.statusCode).toBe(400)
    expect(partial.json()).toMatchObject({ code: 'unknown_field_key', field: 'totp_secret' })
  })

  // AC-4: checklist filtered by field_key against target_fields
  it('AC-4: checklist includes whole-credential deps and only field-matching deps for a field-scoped rotation', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac4-checklist')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const [ciPipeline] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(credentialDependencies)
        .values({
          orgId: owner.orgId,
          credentialId: credential.id,
          systemName: 'CI Pipeline',
          createdBy: owner.userId,
        })
        .returning({ id: credentialDependencies.id })
    )
    const [backupScript] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(credentialDependencies)
        .values({
          orgId: owner.orgId,
          credentialId: credential.id,
          systemName: 'Backup Script',
          createdBy: owner.userId,
          fieldKey: 'password',
        })
        .returning({ id: credentialDependencies.id })
    )
    await withOrg(owner.orgId, (tx) =>
      tx.insert(credentialDependencies).values({
        orgId: owner.orgId,
        credentialId: credential.id,
        systemName: 'Read Replica Config',
        createdBy: owner.userId,
        fieldKey: 'username',
      })
    )
    expect(ciPipeline).toBeDefined()
    expect(backupScript).toBeDefined()

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['password'],
    })
    expect(res.statusCode).toBe(201)
    const names = res
      .json<{ data: { checklistItems: { systemName: string }[] } }>()
      .data.checklistItems.map((i) => i.systemName)
      .sort()
    expect(names).toEqual(['Backup Script', 'CI Pipeline'])
  })

  it('AC-4 (whole-secret, no filtering): all active dependencies appear on the checklist', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac4-whole')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    await withOrg(owner.orgId, (tx) =>
      tx.insert(credentialDependencies).values([
        {
          orgId: owner.orgId,
          credentialId: credential.id,
          systemName: 'Whole A',
          createdBy: owner.userId,
        },
        {
          orgId: owner.orgId,
          credentialId: credential.id,
          systemName: 'Scoped B',
          createdBy: owner.userId,
          fieldKey: 'username',
        },
      ])
    )

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
    })
    expect(res.statusCode).toBe(201)
    const names = res
      .json<{ data: { checklistItems: { systemName: string }[] } }>()
      .data.checklistItems.map((i) => i.systemName)
      .sort()
    expect(names).toEqual(['Scoped B', 'Whole A'])
  })

  // AC-5: staged version is a full field-set snapshot; only targeted field(s) changed
  it('AC-5: staged version carries over non-targeted fields; promote flips current visibility atomically', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac5-snapshot')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    // Before rotation: current value still shows the original fields.
    const before = await app.inject({
      method: 'GET',
      url: credentialValueUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(
      before.json<{ data: { fields: { key: string; value: string }[] } }>().data.fields
    ).toEqual(
      expect.arrayContaining([
        { key: 'username', value: 'svc-1', sensitive: false },
        { key: 'password', value: 'old-pw', sensitive: true },
      ])
    )

    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['password'],
    })
    expect(initiate.statusCode).toBe(201)
    const rotationId = initiate.json<{ data: { id: string } }>().data.id

    // GET .../value still returns the OLD (previous) version's full field set — staged is not current.
    const stillOld = await app.inject({
      method: 'GET',
      url: credentialValueUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(
      stillOld.json<{ data: { fields: { key: string; value: string }[] } }>().data.fields
    ).toEqual(
      expect.arrayContaining([
        { key: 'username', value: 'svc-1', sensitive: false },
        { key: 'password', value: 'old-pw', sensitive: true },
      ])
    )

    const promote = await promoteViaApi(
      app,
      owner.cookies,
      { projectId, credentialId: credential.id, rotationId },
      { acknowledgeIncompleteChecklist: true, acknowledgedNoDependencies: true }
    )
    expect(promote.statusCode).toBe(200)

    const after = await app.inject({
      method: 'GET',
      url: credentialValueUrl(projectId, credential.id),
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    const fields = after.json<{ data: { fields: { key: string; value: string }[] } }>().data.fields
    expect(fields).toEqual(
      expect.arrayContaining([
        { key: 'username', value: 'svc-1', sensitive: false },
        { key: 'password', value: 'new-pw', sensitive: true },
      ])
    )
  })

  // AC-6: existing credential-level lock/conflict reused, no per-field lock
  it('AC-6: a second rotation on a disjoint field set while the first is staged returns 409 rotation_in_progress', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac6-disjoint')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const first = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['password'],
    })
    expect(first.statusCode).toBe(201)
    const firstId = first.json<{ data: { id: string } }>().data.id

    const second = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-username',
      targetFields: ['username'],
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'rotation_in_progress', rotationId: firstId })
  })

  it('AC-6: promoted-but-unretired also blocks a second rotation attempt', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac6-promoted')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const first = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['password'],
    })
    const firstId = first.json<{ data: { id: string } }>().data.id
    await promoteViaApi(
      app,
      owner.cookies,
      { projectId, credentialId: credential.id, rotationId: firstId },
      { acknowledgeIncompleteChecklist: true, acknowledgedNoDependencies: true }
    )

    const second = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'anything',
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'rotation_in_progress', rotationId: firstId })
  })

  // AC-7: legacy secret rotation unchanged
  it('AC-7: a legacy (schema_version=1) secret rotation without targetFields is byte-identical to today', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-legacy')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: `legacy-${randomUUID()}`,
      value: 'legacy-sentinel',
    })

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'legacy-new',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<{ data: { targetFields?: string[] | null } }>().data.targetFields).toBeNull()
  })

  // AC-8: a decrypt failure on a carried-over (non-targeted) field aborts initiation atomically
  it('AC-8: a corrupted current version aborts field-scoped initiation atomically — no rows written', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac8-corrupted')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    // Tamper the current version's stored ciphertext so it decrypts to invalid JSON — simulates
    // a corrupted envelope on a field (username, healthy) that must still be carried over to
    // build the new version's full snapshot even though only password is targeted.
    const corrupted = await encryptValue('not-json-at-all{{{')
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(credentialVersions)
        .set({ encryptedValue: corrupted })
        .where(
          and(
            eq(credentialVersions.credentialId, credential.id),
            eq(credentialVersions.versionNumber, 1)
          )
        )
    )

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['password'],
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(500)

    // Zero side effects: no new rotations row, no new credential_versions row for this
    // credential (still exactly the one, corrupted, original version).
    const rotationRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: rotations.id })
        .from(rotations)
        .where(eq(rotations.credentialId, credential.id))
    )
    expect(rotationRows).toHaveLength(0)

    const versionRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: credentialVersions.id })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, credential.id))
    )
    expect(versionRows).toHaveLength(1)
  })

  // AC-9: audit event records target_fields keys, never values
  it('AC-9: rotation-initiated audit entry records targetFields keys, never the new value', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac9-audit')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'super-secret-new-pw',
      targetFields: ['password'],
    })
    expect(res.statusCode).toBe(201)
    const rotationId = res.json<{ data: { id: string } }>().data.id

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'rotation.initiated'))
    )
    const match = auditRows.find((row) => row.resourceId === rotationId)
    expect(match).toBeDefined()
    const payload = match?.payload as { targetFields?: string[] | null }
    expect(payload.targetFields).toEqual(['password'])
    expect(JSON.stringify(payload)).not.toContain('super-secret-new-pw')
  })

  // Task 3 subtask: promoteRotation/retireRotation require zero changes — a field-scoped
  // rotation's promote/retire behave identically to a whole-secret rotation's.
  it('promoteRotation/retireRotation work unmodified against a field-scoped staged rotation', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'promote-retire-fs')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const initiate = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-pw',
      targetFields: ['password'],
    })
    const rotationId = initiate.json<{ data: { id: string } }>().data.id

    const promote = await promoteViaApi(
      app,
      owner.cookies,
      { projectId, credentialId: credential.id, rotationId },
      { acknowledgeIncompleteChecklist: true, acknowledgedNoDependencies: true }
    )
    expect(promote.statusCode).toBe(200)
    expect(promote.json()).toMatchObject({ data: { status: 'promoted' } })

    const retire = await app.inject({
      method: 'POST',
      url: `${rotationsUrl(projectId, credential.id)}/${rotationId}/retire`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { acknowledgeIncompleteChecklist: true, acknowledgedNoDependencies: true },
    })
    expect(retire.statusCode).toBe(200)
    expect(retire.json()).toMatchObject({ data: { status: 'retired' } })
  })

  // Dev Notes ADR: selecting every field explicitly stays a materialized list, distinct from NULL
  it('selecting every field key explicitly produces a materialized target_fields list, not NULL', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac-all-fields')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'new-value-for-all',
      targetFields: ['username', 'password'],
    })
    expect(res.statusCode).toBe(201)
    const targetFields = res.json<{ data: { targetFields?: string[] | null } }>().data.targetFields
    expect(targetFields).not.toBeNull()
    expect([...(targetFields ?? [])].sort()).toEqual(['password', 'username'])
  })
})
