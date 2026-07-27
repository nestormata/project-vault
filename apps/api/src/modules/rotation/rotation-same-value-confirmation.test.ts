import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialVersions, rotations } from '@project-vault/db/schema'
import {
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
  SENTINEL_VALUE,
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

const ROTATION_INITIATED_EVENT_TYPE = 'rotation.initiated'

function rotationsUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations${suffix}`
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

describe.sequential('rotation same-value confirmation + per-field fieldValues (Story 13.5)', () => {
  let app: TestApp
  let owner: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      'rotation-same-value-passphrase',
      PASSWORD,
      'same-value'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function rotationRowCount(credentialId: string) {
    const rows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: rotations.id })
        .from(rotations)
        .where(eq(rotations.credentialId, credentialId))
    )
    return rows.length
  }

  // AC-1 happy path: whole-secret, no confirmation, rejected
  it('AC-1: whole-secret same-value rotation without confirmSameValue is rejected with 409, zero writes', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac1-whole')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: SENTINEL_VALUE,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'same_value_confirmation_required', field: null })
    expect(await rotationRowCount(credential.id)).toBe(0)
  })

  // AC-1 field-scoped example
  it('AC-1: field-scoped same-value rotation without confirmSameValue is rejected with the targeted field', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac1-field')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['password'],
      newValue: 'old-pw',
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'same_value_confirmation_required',
      field: 'password',
    })
    expect(await rotationRowCount(credential.id)).toBe(0)
  })

  // AC-1 edge: multi-field with fieldValues, only one field matches
  it('AC-1: multi-field fieldValues with only one field matching still blocks the whole request', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac1-partial')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['username', 'password'],
      newValue: 'unused',
      fieldValues: { username: 'svc-2', password: 'old-pw' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'same_value_confirmation_required',
      field: 'password',
    })
    expect(await rotationRowCount(credential.id)).toBe(0)
  })

  // AC-2 happy path
  it('AC-2: confirmSameValue: true proceeds and marks the audit payload sameValueConfirmed', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac2-confirm')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['password'],
      newValue: 'old-pw',
      confirmSameValue: true,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ data: { id: string; sameValueAsPrevious?: boolean } }>()
    expect(body.data.sameValueAsPrevious).toBe(true)

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, ROTATION_INITIATED_EVENT_TYPE))
    )
    const match = auditRows.find((row) => row.resourceId === body.data.id)
    expect(match).toBeDefined()
    expect((match?.payload as { sameValueConfirmed?: boolean }).sameValueConfirmed).toBe(true)
  })

  // AC-2 edge: confirmSameValue true on a genuinely-different value is ignored, not an error, and
  // omitted from the audit payload
  it('AC-2: confirmSameValue: true on a genuinely different value is ignored and omitted from the audit payload', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac2-ignore')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'genuinely-new-value',
      confirmSameValue: true,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ data: { id: string; sameValueAsPrevious?: boolean } }>()
    expect(body.data.sameValueAsPrevious).toBe(false)

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, ROTATION_INITIATED_EVENT_TYPE))
    )
    const match = auditRows.find((row) => row.resourceId === body.data.id)
    expect(match).toBeDefined()
    expect(match?.payload as Record<string, unknown>).not.toHaveProperty('sameValueConfirmed')
  })

  // AC-4: existing lock/conflict path governs a confirmed same-value request exactly like any
  // other concurrent rotation attempt — no new concurrency primitive.
  it('AC-4: a confirmed same-value rotation still respects the existing rotation_in_progress lock', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac4-lock')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const first = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'first-new-value',
    })
    expect(first.statusCode).toBe(201)
    const firstId = first.json<{ data: { id: string } }>().data.id

    const second = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: SENTINEL_VALUE,
      confirmSameValue: true,
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'rotation_in_progress', rotationId: firstId })
  })

  // AC-7 happy path: fieldValues supplies distinct per-field values
  it('AC-7: fieldValues sets each targeted field to its own distinct value', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-happy')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['username', 'password'],
      newValue: 'unused-placeholder',
      fieldValues: { username: 'svc-2', password: 'new-pw' },
    })
    expect(res.statusCode).toBe(201)

    const rotationId = res.json<{ data: { id: string } }>().data.id
    const rotationRow = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ newVersionId: rotations.newVersionId })
        .from(rotations)
        .where(eq(rotations.id, rotationId))
    )
    const newVersionId = rotationRow[0]?.newVersionId
    expect(newVersionId).toBeTruthy()
    const versionRow = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: credentialVersions.id })
        .from(credentialVersions)
        .where(eq(credentialVersions.id, newVersionId as string))
    )
    expect(versionRow).toHaveLength(1)
  })

  // AC-7 edge: missing key mismatch
  it('AC-7: fieldValues missing a targeted key is rejected with field_values_target_mismatch', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-missing')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['username', 'password'],
      newValue: 'x',
      fieldValues: { username: 'svc-2' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'field_values_target_mismatch',
      missing: ['password'],
      extra: [],
    })
    expect(await rotationRowCount(credential.id)).toBe(0)
  })

  // AC-7 edge: extra key mismatch
  it('AC-7: fieldValues with an extra untargeted key is rejected with field_values_target_mismatch', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-extra')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['password'],
      newValue: 'x',
      fieldValues: { password: 'new-pw', username: 'svc-2' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'field_values_target_mismatch',
      missing: [],
      extra: ['username'],
    })
    expect(await rotationRowCount(credential.id)).toBe(0)
  })

  // AC-7 edge: single field, fieldValues omitted, unchanged behavior
  it('AC-7: a single targeted field with fieldValues omitted behaves identically to Story 13.4', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-omitted')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['password'],
      newValue: 'new-pw',
    })
    expect(res.statusCode).toBe(201)
  })

  // AC-7 edge: whole-secret rotation with fieldValues present is rejected
  it('AC-7: whole-secret rotation with fieldValues present is rejected as a mismatch (extra keys)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-whole-secret')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      newValue: 'x',
      fieldValues: { password: 'y' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      code: 'field_values_target_mismatch',
      missing: [],
      extra: ['password'],
    })
    expect(await rotationRowCount(credential.id)).toBe(0)
  })

  // AC-7 edge: mixed-case key normalization
  it('AC-7: a mixed-case fieldValues key normalizes to match a lowercase targetFields entry', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-case')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['password'],
      newValue: 'x',
      fieldValues: { Password: 'new-pw' },
    })
    expect(res.statusCode).toBe(201)
  })

  // AC-7 interaction with AC-1: same-value detection compares per-field fieldValues
  it('AC-7/AC-1 interaction: fieldValues matching the current value blocks with same_value_confirmation_required', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-ac1-interaction')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['password'],
      newValue: 'unused',
      fieldValues: { password: 'old-pw' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'same_value_confirmation_required',
      field: 'password',
    })
  })

  // AC-7: audit never records fieldValues
  it('AC-7: the ROTATION_INITIATED audit payload never contains fieldValues keys or values', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ac7-audit')
    const credential = await createMultiFieldCredential(app, owner.cookies, projectId)

    const res = await initiateRotationViaApi(app, owner.cookies, projectId, credential.id, {
      targetFields: ['username', 'password'],
      newValue: 'unused-placeholder',
      fieldValues: { username: 'svc-2-secret', password: 'new-pw-secret' },
    })
    expect(res.statusCode).toBe(201)
    const rotationId = res.json<{ data: { id: string } }>().data.id

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, ROTATION_INITIATED_EVENT_TYPE))
    )
    const match = auditRows.find((row) => row.resourceId === rotationId)
    expect(match).toBeDefined()
    const payloadStr = JSON.stringify(match?.payload)
    expect(payloadStr).not.toContain('fieldValues')
    expect(payloadStr).not.toContain('svc-2-secret')
    expect(payloadStr).not.toContain('new-pw-secret')
  })
})
