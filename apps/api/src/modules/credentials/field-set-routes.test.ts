import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialVersions, credentials } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { encryptValue } from '../../lib/encrypt-value.js'
import {
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
} from './credential-route-test-helpers.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type RegisteredUser = { userId: string; orgId: string; cookies: Record<string, string> }

const TEST_PASSPHRASE = 'field-set-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const FORCED_AUDIT_FAILURE = 'forced audit failure'
const DB_HOST_VALUE = 'db.example.com'
const LEGACY_VALUE = 'legacy-value'

type Cookies = Record<string, string>

function createUrl(projectId: string) {
  return `/api/v1/projects/${projectId}/credentials`
}
function versionsUrl(projectId: string, credentialId: string) {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`
}

async function create(app: TestApp, cookies: Cookies, projectId: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: createUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body as Record<string, unknown>,
  })
}
async function addVersion(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  credentialId: string,
  body: unknown
) {
  return app.inject({
    method: 'POST',
    url: versionsUrl(projectId, credentialId),
    headers: { cookie: cookieHeader(cookies) },
    payload: body as Record<string, unknown>,
  })
}
async function getDetail(app: TestApp, cookies: Cookies, projectId: string, credentialId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}
async function reveal(app: TestApp, cookies: Cookies, projectId: string, credentialId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/value`,
    headers: { cookie: cookieHeader(cookies) },
  })
}
// Story 13.3 — field-scoped reveal.
async function revealField(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  credentialId: string,
  field: string
) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/value?field=${encodeURIComponent(field)}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}
async function revealAuditRows(orgId: string, credentialId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(auditLogEntries)
      .where(
        and(
          eq(auditLogEntries.eventType, 'credential.value_revealed'),
          eq(auditLogEntries.resourceId, credentialId)
        )
      )
  )
}
async function listVersions(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  credentialId: string
) {
  return app.inject({
    method: 'GET',
    url: versionsUrl(projectId, credentialId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

type DetailBody = {
  data: {
    id: string
    schemaVersion: number
    fields: Array<{ key: string; sensitive: boolean; template?: string }>
  }
}

async function createFieldSet(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  body: Record<string, unknown>
): Promise<string> {
  const res = await create(app, cookies, projectId, body)
  expect(res.statusCode).toBe(201)
  return res.json<DetailBody>().data.id
}

async function versionRow(orgId: string, credentialId: string, versionNumber: number) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select()
      .from(credentialVersions)
      .where(
        and(
          eq(credentialVersions.credentialId, credentialId),
          eq(credentialVersions.versionNumber, versionNumber)
        )
      )
  )
  return row
}

async function currentVersionId(orgId: string, credentialId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ currentVersionId: credentials.currentVersionId })
      .from(credentials)
      .where(eq(credentials.id, credentialId))
  )
  return row?.currentVersionId ?? null
}

/**
 * Builds a genuine legacy schema_version = 1 row (bare-string ciphertext, null field_meta) — NOT a
 * schema_version = 2 row with a single field, which looks similar but skips the legacy-ciphertext
 * code path. Required by the epic preamble's legacy-row test mandate (AC-7).
 */
async function makeLegacyCredential(
  app: TestApp,
  cookies: Cookies,
  projectId: string,
  bareValue: string
): Promise<string> {
  const id = await createFieldSet(app, cookies, projectId, { name: 'Legacy Secret', value: 'seed' })
  const legacyCiphertext = await encryptValue(bareValue)
  await withOrg(owner.orgId, (tx) =>
    tx
      .update(credentialVersions)
      .set({ schemaVersion: 1, fieldMeta: null, encryptedValue: legacyCiphertext })
      .where(and(eq(credentialVersions.credentialId, id), eq(credentialVersions.versionNumber, 1)))
  )
  return id
}

let app: TestApp
let owner: RegisteredUser

describe.sequential('credential field-set routes (Story 13.2)', () => {
  beforeAll(async () => {
    ;({ app, owner } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'field-set'
    ))
  })

  afterAll(async () => {
    await app.close()
  })

  it('AC-2: rejects an unknown template value with 422 (never treated as custom)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'unknown-template')
    const res = await create(app, owner.cookies, projectId, {
      name: 'Bad',
      template: 'sftp_login',
      fields: [{ key: 'value', value: 'x', sensitive: true }],
    })
    expect(res.statusCode).toBe(422)
  })

  it('AC-5: create with no template synthesizes exactly one default field at schema_version 2', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'no-template')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Legacy shape',
      value: 'sk_live_default',
    })
    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<DetailBody>().data
    expect(detail.schemaVersion).toBe(2)
    expect(detail.fields).toEqual([{ key: 'value', sensitive: true }])

    const row = await versionRow(owner.orgId, id, 1)
    expect(row?.schemaVersion).toBe(2)
    // reveal returns the bare value (backward compatible with existing single-value clients)
    const revealed = (await reveal(app, owner.cookies, projectId, id)).json<{
      data: { value: string }
    }>().data
    expect(revealed.value).toBe('sk_live_default')
  })

  it('AC-1/AC-2/AC-4: create a login field set; field_meta carries keys/sensitivity/template, never a value', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'login-template')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'DB login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret-pw', sensitive: true },
      ],
    })
    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<DetailBody>().data
    expect(detail.schemaVersion).toBe(2)
    expect(detail.fields).toEqual([
      { key: 'username', sensitive: false, template: 'login' },
      { key: 'password', sensitive: true, template: 'login' },
    ])

    // field_meta (raw, unencrypted column) must contain no field value substring.
    const row = await versionRow(owner.orgId, id, 1)
    expect(JSON.stringify(row?.fieldMeta)).not.toContain('alice')
    expect(JSON.stringify(row?.fieldMeta)).not.toContain('s3cret-pw')
    // current_version_id was flipped to the first version.
    expect(await currentVersionId(owner.orgId, id)).toBe(row?.id)
  })

  it('AC-3: duplicate field keys on create are rejected with 409 field_key_conflict', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'dup-create')
    const res = await create(app, owner.cookies, projectId, {
      name: 'Dup',
      fields: [
        { key: 'token', value: 'a', sensitive: true },
        { key: 'Token', value: 'b', sensitive: true },
      ],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('field_key_conflict')
  })

  it('AC-3: rename collision on edit rejects with 409 and has zero side effects', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'rename-collision')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Creds',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 'pw', sensitive: true },
      ],
    })
    const beforePointer = await currentVersionId(owner.orgId, id)

    // rename password -> Username (case-insensitive collision with existing username)
    const res = await addVersion(app, owner.cookies, projectId, id, {
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'Username', value: 'pw', sensitive: true },
      ],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('field_key_conflict')

    // no new version, pointer unchanged, original fields intact
    expect(await versionRow(owner.orgId, id, 2)).toBeUndefined()
    expect(await currentVersionId(owner.orgId, id)).toBe(beforePointer)
    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<DetailBody>().data
    expect(detail.fields.map((f) => f.key)).toEqual(['username', 'password'])

    // and no audit event for the failed write (AC-9)
    const audits = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.eventType, 'credential.version_created'),
            eq(auditLogEntries.resourceId, id)
          )
        )
    )
    expect(audits).toHaveLength(0)
  })

  it('AC-3: adding a new field colliding with an existing key is rejected (uniqueness applies to add)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'add-collision')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'ApiKeyed',
      fields: [{ key: 'apiKey', value: 'a', sensitive: true }],
    })
    const res = await addVersion(app, owner.cookies, projectId, id, {
      fields: [
        { key: 'apiKey', value: 'a', sensitive: true },
        { key: 'ApiKey', value: 'b', sensitive: true },
      ],
    })
    expect(res.statusCode).toBe(409)
  })

  it('AC-3: removing a field then re-adding a field under the freed key in the same save is allowed', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'remove-reuse')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      fields: [
        { key: 'old', value: '1', sensitive: false },
        { key: 'keep', value: '2', sensitive: false },
      ],
      name: 'Reuse',
    })
    // final set drops nothing that collides — 'old' removed, a different field re-uses no existing key
    const res = await addVersion(app, owner.cookies, projectId, id, {
      fields: [
        { key: 'keep', value: '2', sensitive: false },
        { key: 'old', value: '3', sensitive: false },
      ],
    })
    expect(res.statusCode).toBe(201)
  })

  it('AC-3: whitespace-trim collision is rejected (keys trimmed before comparison)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'ws-collision')
    const res = await create(app, owner.cookies, projectId, {
      name: 'WS',
      fields: [
        { key: 'password', value: 'a', sensitive: true },
        { key: 'password ', value: 'b', sensitive: true },
      ],
    })
    expect(res.statusCode).toBe(409)
  })

  it('AC-4: editing one field writes a COMPLETE new envelope; every other field round-trips unchanged', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'round-trip')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'DB',
      template: 'db_connection',
      fields: [
        { key: 'host', value: DB_HOST_VALUE, sensitive: false },
        { key: 'username', value: 'svc', sensitive: false },
        { key: 'password', value: 'old-pw', sensitive: true },
      ],
    })
    // client re-sends ALL fields, changing only password
    const res = await addVersion(app, owner.cookies, projectId, id, {
      template: 'db_connection',
      fields: [
        { key: 'host', value: DB_HOST_VALUE, sensitive: false },
        { key: 'username', value: 'svc', sensitive: false },
        { key: 'password', value: 'new-pw', sensitive: true },
      ],
    })
    expect(res.statusCode).toBe(201)

    // Story 13.3 AC-5 — reveal the current (multi-field) version: returns the structured
    // `fields[]` array, never a JSON string masquerading as `value` (the Story 13.2 carryover bug
    // this story fixes).
    const revealedRes = await reveal(app, owner.cookies, projectId, id)
    const revealed = revealedRes.json<{ data: { fields: Array<{ key: string; value: string }> } }>()
      .data
    expect(revealedRes.json<{ data: { value?: string } }>().data.value).toBeUndefined()
    const byKey = new Map(revealed.fields.map((f) => [f.key, f.value]))
    expect(byKey.get('host')).toBe(DB_HOST_VALUE)
    expect(byKey.get('username')).toBe('svc')
    expect(byKey.get('password')).toBe('new-pw')

    // version_number is monotonic (shared sequence)
    expect((await versionRow(owner.orgId, id, 2))?.versionNumber).toBe(2)
    expect(await currentVersionId(owner.orgId, id)).toBe((await versionRow(owner.orgId, id, 2))?.id)
  })

  it('AC-4: version insert + current_version_id flip + audit are one transaction (rollback on audit failure)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'atomic-rollback')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Atomic',
      fields: [{ key: 'value', value: 'v1', sensitive: true }],
    })
    const beforePointer = await currentVersionId(owner.orgId, id)

    const spy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    try {
      const res = await addVersion(app, owner.cookies, projectId, id, {
        fields: [{ key: 'value', value: 'v2', sensitive: true }],
      })
      expectAuditWriteFailed(res)
    } finally {
      spy.mockRestore()
    }

    // whole transaction rolled back: no v2 row, pointer unchanged
    expect(await versionRow(owner.orgId, id, 2)).toBeUndefined()
    expect(await currentVersionId(owner.orgId, id)).toBe(beforePointer)
  })

  it('AC-8: a field-set edit succeeds without any prior reveal call (blind overwrite)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'blind-overwrite')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Blind',
      template: 'login',
      fields: [
        { key: 'username', value: 'u', sensitive: false },
        { key: 'password', value: 'old', sensitive: true },
      ],
    })
    // directly overwrite the sensitive field with no GET .../value beforehand
    const res = await addVersion(app, owner.cookies, projectId, id, {
      template: 'login',
      fields: [
        { key: 'username', value: 'u', sensitive: false },
        { key: 'password', value: 'brand-new', sensitive: true },
      ],
    })
    expect(res.statusCode).toBe(201)
  })

  it('AC-9: a successful field-set edit audits changed keys + template, never a plaintext value', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'audit-delta')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Audited',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 'pw', sensitive: true },
      ],
    })
    // rename username -> login, add notes
    const res = await addVersion(app, owner.cookies, projectId, id, {
      template: 'login',
      fields: [
        { key: 'login', value: 'alice', sensitive: false },
        { key: 'password', value: 'pw', sensitive: true },
        { key: 'notes', value: 'top secret note', sensitive: false },
      ],
    })
    expect(res.statusCode).toBe(201)

    const [audit] = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.eventType, 'credential.version_created'),
            eq(auditLogEntries.resourceId, id)
          )
        )
    )
    const payload = audit?.payload as {
      addedFields: string[]
      removedFields: string[]
      template: string
    }
    expect(payload.template).toBe('login')
    expect(payload.addedFields.sort()).toEqual(['login', 'notes'])
    expect(payload.removedFields).toEqual(['username'])
    // never any plaintext value
    expect(JSON.stringify(payload)).not.toContain('alice')
    expect(JSON.stringify(payload)).not.toContain('top secret note')
  })

  // -------- Legacy schema_version = 1 fixtures (AC-7, epic preamble mandate) --------

  it('AC-7: getCredentialDetail renders a legacy row as one unnamed default field, schema_version 1', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-detail')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, 'legacy-bare-secret')
    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<DetailBody>().data
    expect(detail.schemaVersion).toBe(1)
    expect(detail.fields).toEqual([{ key: 'value', sensitive: true }])
  })

  it('AC-7: revealCurrentValue decrypts a legacy bare-string row (no JSON.parse of stored bytes)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-reveal')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, 'legacy-plain-value')
    const revealed = (await reveal(app, owner.cookies, projectId, id)).json<{
      data: { value: string }
    }>().data
    expect(revealed.value).toBe('legacy-plain-value')
  })

  it('AC-7: listVersionHistory reports schema_version 1 for a legacy row', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-history')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, 'legacy-hist')
    const items = (await listVersions(app, owner.cookies, projectId, id)).json<{
      data: { items: Array<{ versionNumber: number; schemaVersion: number }> }
    }>().data.items
    expect(items[0]?.schemaVersion).toBe(1)
  })

  it('AC-7: editing a legacy row transitions it to schema_version 2, leaving the v1 row untouched', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-upgrade')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, 'legacy-original')

    const res = await addVersion(app, owner.cookies, projectId, id, { value: 'edited-value' })
    expect(res.statusCode).toBe(201)

    const v1 = await versionRow(owner.orgId, id, 1)
    const v2 = await versionRow(owner.orgId, id, 2)
    expect(v1?.schemaVersion).toBe(1) // old version immutable
    expect(v1?.fieldMeta).toBeNull()
    expect(v2?.schemaVersion).toBe(2)
    expect(v2?.fieldMeta).toEqual([{ key: 'value', sensitive: true }])
    // current pointer moved to the v2 row
    expect(await currentVersionId(owner.orgId, id)).toBe(v2?.id)

    // reveal returns the new bare value (single default field unwrap)
    const revealed = (await reveal(app, owner.cookies, projectId, id)).json<{
      data: { value: string }
    }>().data
    expect(revealed.value).toBe('edited-value')
  })

  it('rejects a legacy { value } edit on an already-multi-field secret with 422, leaving it untouched', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-body-guard')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Multi',
      template: 'login',
      fields: [
        { key: 'username', value: 'bob', sensitive: false },
        { key: 'password', value: 'pw', sensitive: true },
      ],
    })

    const res = await addVersion(app, owner.cookies, projectId, id, { value: 'collapse-attempt' })
    expect(res.statusCode).toBe(422)
    expect(res.json<{ code: string }>().code).toBe('legacy_shape_field_loss')

    // zero side effects: still one version, still both fields
    const items = (await listVersions(app, owner.cookies, projectId, id)).json<{
      data: { items: Array<{ versionNumber: number }> }
    }>().data.items
    expect(items).toHaveLength(1)
    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<{
      data: { fields: Array<{ key: string }> }
    }>().data
    expect(detail.fields.map((f) => f.key)).toEqual(['username', 'password'])
  })

  it('unwrapRevealValue-via-API: reveal returns the bare value for a single-field api_key-templated secret', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'apikey-reveal')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'API key secret',
      template: 'api_key',
      fields: [{ key: 'key', value: 'sk_live_abc123', sensitive: true }],
    })
    const revealed = (await reveal(app, owner.cookies, projectId, id)).json<{
      data: { value: string }
    }>().data
    expect(revealed.value).toBe('sk_live_abc123')
  })
})

type FieldsValueBody = {
  data: {
    fields: Array<{ key: string; value: string; sensitive: boolean }>
    schemaVersion: number
    versionNumber: number
  }
}

describe.sequential('credential field-scoped reveal routes (Story 13.3)', () => {
  beforeAll(async () => {
    ;({ app, owner } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'field-reveal'
    ))
  })

  afterAll(async () => {
    await app.close()
  })

  it('AC-4: ?field=password on a login secret returns only that field, revealed_fields=[password]', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'field-reveal-single')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })

    const res = await revealField(app, owner.cookies, projectId, id, 'password')
    expect(res.statusCode).toBe(200)
    const body = res.json<FieldsValueBody>()
    expect(body.data.fields).toEqual([{ key: 'password', value: 's3cret', sensitive: true }])

    const [audit] = await revealAuditRows(owner.orgId, id)
    expect(audit?.revealedFields).toEqual(['password'])
  })

  it('AC-4 negative: ?field=username (non-sensitive) still writes revealed_fields=[username]', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'field-reveal-nonsens')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })

    const res = await revealField(app, owner.cookies, projectId, id, 'username')
    expect(res.statusCode).toBe(200)
    const body = res.json<FieldsValueBody>()
    expect(body.data.fields).toEqual([{ key: 'username', value: 'alice', sensitive: false }])

    const [audit] = await revealAuditRows(owner.orgId, id)
    expect(audit?.revealedFields).toEqual(['username'])
  })

  it('AC-4: two back-to-back field reveals produce two separate single-element audit entries', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'field-reveal-twice')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })

    expect((await revealField(app, owner.cookies, projectId, id, 'username')).statusCode).toBe(200)
    expect((await revealField(app, owner.cookies, projectId, id, 'password')).statusCode).toBe(200)

    const audits = await revealAuditRows(owner.orgId, id)
    expect(audits).toHaveLength(2)
    expect(audits.map((a) => a.revealedFields).sort()).toEqual([['password'], ['username']])
  })

  it('AC-5: whole-secret reveal (no ?field=) returns every field, revealed_fields names only sensitive ones', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'whole-secret-reveal')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'DB',
      template: 'db_connection',
      fields: [
        { key: 'host', value: DB_HOST_VALUE, sensitive: false },
        { key: 'port', value: '5432', sensitive: false },
        { key: 'database', value: 'app', sensitive: false },
        { key: 'username', value: 'svc', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })

    const res = await reveal(app, owner.cookies, projectId, id)
    expect(res.statusCode).toBe(200)
    const body = res.json<FieldsValueBody>()
    expect(body.data.fields).toHaveLength(5)
    const byKey = new Map(body.data.fields.map((f) => [f.key, f.value]))
    expect(byKey.get('host')).toBe(DB_HOST_VALUE)
    expect(byKey.get('password')).toBe('s3cret')

    const [audit] = await revealAuditRows(owner.orgId, id)
    expect(audit?.revealedFields).toEqual(['password'])
  })

  it('AC-5 negative: two sensitive fields — revealed_fields order matches field_meta declared order', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'two-sensitive-order')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Custom',
      template: 'custom',
      fields: [
        { key: 'password', value: 'pw', sensitive: true },
        { key: 'recovery_code', value: 'rc', sensitive: true },
      ],
    })

    const res = await reveal(app, owner.cookies, projectId, id)
    const [audit] = await revealAuditRows(owner.orgId, id)
    expect(audit?.revealedFields).toEqual(['password', 'recovery_code'])
    expect(res.json<FieldsValueBody>().data.fields.map((f) => f.key)).toEqual([
      'password',
      'recovery_code',
    ])
  })

  it('AC-5 Failure Mode: a corrupted envelope on a multi-field secret fails atomically — no audit row, no fields', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'corrupted-envelope')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })
    // tamper the stored ciphertext so it decrypts to invalid JSON (simulates a corrupted row)
    const corrupted = await encryptValue('not-json-at-all{{{')
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(credentialVersions)
        .set({ encryptedValue: corrupted })
        .where(
          and(eq(credentialVersions.credentialId, id), eq(credentialVersions.versionNumber, 1))
        )
    )

    const res = await reveal(app, owner.cookies, projectId, id)
    expect(res.statusCode).toBeGreaterThanOrEqual(500)

    const audits = await revealAuditRows(owner.orgId, id)
    expect(audits).toHaveLength(0)
  })

  it('AC-6: legacy schema_version=1 reveal writes revealed_fields = NULL, not []', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-revealed-null')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, LEGACY_VALUE)

    const res = await reveal(app, owner.cookies, projectId, id)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { value: string } }>().data.value).toBe(LEGACY_VALUE)

    const [audit] = await revealAuditRows(owner.orgId, id)
    expect(audit?.revealedFields).toBeNull()
  })

  it('AC-6 negative: ?field=value on a genuine legacy row is rejected 400 unknown_field_key (lookalike case)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'legacy-field-guess')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, LEGACY_VALUE)

    const res = await revealField(app, owner.cookies, projectId, id, 'value')
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('unknown_field_key')

    const audits = await revealAuditRows(owner.orgId, id)
    expect(audits).toHaveLength(0)
  })

  it('AC-6 (lookalike contrast): ?field=value on a real single-default-field v2 row IS accepted', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'default-field-guess')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'No template',
      value: 'default-field-value',
    })

    // AC-6: a single-default-field v2 row still collapses to the bare-string shape (matching
    // legacy backward compatibility) even under an explicit `?field=` — only a genuinely
    // multi-field secret gets the structured `fields[]` shape (AC-5/AC-6's last edge case).
    const res = await revealField(app, owner.cookies, projectId, id, 'value')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { value: string } }>().data.value).toBe('default-field-value')

    const [audit] = await revealAuditRows(owner.orgId, id)
    expect(audit?.revealedFields).toEqual(['value'])
  })

  it('AC-7: unknown ?field= on a real login secret is rejected 400, zero audit rows', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'unknown-field-key')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })

    const res = await revealField(app, owner.cookies, projectId, id, 'totp_secret')
    expect(res.statusCode).toBe(400)
    const body = res.json<{ code: string; message: string }>()
    expect(body.code).toBe('unknown_field_key')
    expect(body.message).toContain('totp_secret')

    const audits = await revealAuditRows(owner.orgId, id)
    expect(audits).toHaveLength(0)
  })

  it('AC-7 negative: malformed ?field= (empty string) is rejected 422, distinct from the 400 business error', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'malformed-field-key')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [{ key: 'username', value: 'alice', sensitive: false }],
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/credentials/${id}/value?field=`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(res.statusCode).toBe(422)
  })

  it('AC-3: revealing an empty-string sensitive field returns an empty value, not an error', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'empty-sensitive-field')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: '', sensitive: true },
      ],
    })

    const res = await revealField(app, owner.cookies, projectId, id, 'password')
    expect(res.statusCode).toBe(200)
    const body = res.json<FieldsValueBody>()
    expect(body.data.fields).toEqual([{ key: 'password', value: '', sensitive: true }])
  })

  it('AC-2: detail response eagerly includes non-sensitive field values with no reveal audit entry', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'eager-nonsensitive')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })

    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<{
      data: { visibleFieldValues: Record<string, string> }
    }>().data
    expect(detail.visibleFieldValues).toEqual({ username: 'alice' })
    // never leaks the sensitive field's value via the eager path
    expect(Object.keys(detail.visibleFieldValues)).not.toContain('password')

    const audits = await revealAuditRows(owner.orgId, id)
    expect(audits).toHaveLength(0)
  })

  it('AC-2 negative: a legacy secret has no non-sensitive fields — visibleFieldValues is empty', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'eager-legacy')
    const id = await makeLegacyCredential(app, owner.cookies, projectId, LEGACY_VALUE)

    const detail = (await getDetail(app, owner.cookies, projectId, id)).json<{
      data: { visibleFieldValues: Record<string, string> }
    }>().data
    expect(detail.visibleFieldValues).toEqual({})
  })

  it('AC-2 Failure Mode: a corrupted envelope degrades to an empty visibleFieldValues map, not a 500', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'eager-corrupted')
    const id = await createFieldSet(app, owner.cookies, projectId, {
      name: 'Login',
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cret', sensitive: true },
      ],
    })
    const corrupted = await encryptValue('not-json-at-all{{{')
    await withOrg(owner.orgId, (tx) =>
      tx
        .update(credentialVersions)
        .set({ encryptedValue: corrupted })
        .where(
          and(eq(credentialVersions.credentialId, id), eq(credentialVersions.versionNumber, 1))
        )
    )

    const res = await getDetail(app, owner.cookies, projectId, id)
    expect(res.statusCode).toBe(200)
    const detail = res.json<{ data: { visibleFieldValues: Record<string, string> } }>().data
    expect(detail.visibleFieldValues).toEqual({})
  })
})
