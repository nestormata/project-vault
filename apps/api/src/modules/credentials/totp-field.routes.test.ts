import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries } from '@project-vault/db/schema'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { buildExportBundle } from '../project-export/service.js'
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
} from './credential-route-test-helpers.js'
import { generateTotpCode } from './totp-field.js'

// Story 72.10 (P5): field kinds and the TOTP kind. A seed is write-only: it may enter on a write
// and must never come back out of a read, a reveal, an audit row, a response error or an export.

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'totp-field',
  orgNamePrefix: 'TotpField',
})

// The RFC 6238 SHA-1 test secret ("12345678901234567890"); a throwaway value only.
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const NEW_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const REVEALED = 'credential.value_revealed'
const AUTHENTICATOR = 'Authenticator'
const ORIGINAL_BYPASS = process.env['RATE_LIMIT_TEST_BYPASS']

describe('credential field kinds and the TOTP kind (72-10)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootCredentialRouteApp(createApp, initVault, 'totp-field-passphrase')
  })

  afterEach(() => {
    if (ORIGINAL_BYPASS === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
    else process.env['RATE_LIMIT_TEST_BYPASS'] = ORIGINAL_BYPASS
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  function call(
    cookies: Record<string, string>,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown
  ) {
    return app.inject({ method, url, headers: { cookie: cookieHeader(cookies) }, payload })
  }

  async function createLogin(
    cookies: Record<string, string>,
    projectId: string,
    totpValue = SEED,
    name = 'Login with 2FA'
  ) {
    return call(cookies, 'POST', `/api/v1/projects/${projectId}/credentials`, {
      name,
      template: 'login',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 'hunter2-not-a-real-one', sensitive: true },
        { key: 'recovery', value: 'line one\nline two', sensitive: true, kind: 'multiline' },
        { key: 'Authenticator', value: totpValue, sensitive: false, kind: 'totp' },
      ],
    })
  }

  async function auditRows(orgId: string, eventType: string, resourceId: string) {
    return withOrg(orgId, (tx) =>
      tx
        .select({
          payload: auditLogEntries.payload,
          revealedFields: auditLogEntries.revealedFields,
        })
        .from(auditLogEntries)
        .where(
          and(eq(auditLogEntries.eventType, eventType), eq(auditLogEntries.resourceId, resourceId))
        )
        .orderBy(desc(auditLogEntries.createdAt))
    )
  }

  it('stores kinds in the field metadata, forces the totp field sensitive and never returns the seed', async () => {
    const owner = await registerOwner(app, 'detail-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-detail')
    const created = await createLogin(owner.cookies, projectId)
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain(SEED)
    const id = created.json<{ data: { id: string } }>().data.id

    const detail = await call(
      owner.cookies,
      'GET',
      `/api/v1/projects/${projectId}/credentials/${id}`
    )
    expect(detail.statusCode).toBe(200)
    expect(detail.body).not.toContain(SEED)
    const fields = detail.json<{ data: { fields: Array<Record<string, unknown>> } }>().data.fields
    expect(fields).toEqual([
      { key: 'username', sensitive: false, template: 'login' },
      { key: 'password', sensitive: true, template: 'login' },
      { key: 'recovery', sensitive: true, template: 'login', kind: 'multiline' },
      { key: 'Authenticator', sensitive: true, template: 'login', kind: 'totp' },
    ])
  }, 60_000)

  it('leaves the totp field out of a whole reveal and refuses to reveal it by name', async () => {
    const owner = await registerOwner(app, 'reveal-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-reveal')
    const id = (await createLogin(owner.cookies, projectId)).json<{ data: { id: string } }>().data
      .id
    const base = `/api/v1/projects/${projectId}/credentials/${id}/value`

    const whole = await call(owner.cookies, 'GET', base)
    expect(whole.statusCode).toBe(200)
    expect(whole.body).not.toContain(SEED)
    const returned = whole
      .json<{ data: { fields: Array<{ key: string }> } }>()
      .data.fields.map((entry) => entry.key)
    expect(returned).toEqual(['username', 'password', 'recovery'])

    const named = await call(owner.cookies, 'GET', `${base}?field=Authenticator`)
    expect(named.statusCode).toBe(400)
    expect(named.json()).toMatchObject({ code: 'unknown_field_key' })
    expect(named.body).not.toContain(SEED)

    const rows = await auditRows(owner.orgId, REVEALED, id)
    // The refused request wrote nothing; the whole reveal names the sensitive fields it returned.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.revealedFields).toEqual(['password', 'recovery'])
  }, 60_000)

  it('generates the current code, audits it as purpose totp and keeps the seed out of the audit trail', async () => {
    const owner = await registerOwner(app, 'code-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-code')
    const id = (await createLogin(owner.cookies, projectId)).json<{ data: { id: string } }>().data
      .id
    const url = `/api/v1/projects/${projectId}/credentials/${id}/totp`

    const before = Date.now()
    const res = await call(owner.cookies, 'POST', url, { field: 'authenticator' })
    const after = Date.now()
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).not.toContain(SEED)
    const data = res.json<{
      data: {
        field: string
        code: string
        digits: number
        periodSeconds: number
        expiresAt: string
      }
    }>().data
    expect(data).toMatchObject({ field: 'Authenticator', digits: 6, periodSeconds: 30 })
    // The same vetted library, asked for the moments around the request, must agree.
    const acceptable = new Set([
      generateTotpCode(SEED, before)?.code,
      generateTotpCode(SEED, after)?.code,
    ])
    expect(acceptable.has(data.code)).toBe(true)

    const rows = await auditRows(owner.orgId, REVEALED, id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload).toEqual({ versionNumber: 1, purpose: 'totp' })
    expect(rows[0]?.revealedFields).toEqual(['Authenticator'])
    expect(JSON.stringify(rows)).not.toContain(SEED)
    expect(JSON.stringify(rows)).not.toContain(data.code)
  }, 60_000)

  it('answers a missing field, another kind and a missing credential without leaking anything', async () => {
    const owner = await registerOwner(app, 'unknown-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-unknown')
    const id = (await createLogin(owner.cookies, projectId)).json<{ data: { id: string } }>().data
      .id
    const url = `/api/v1/projects/${projectId}/credentials/${id}/totp`

    const absent = await call(owner.cookies, 'POST', url, { field: 'nope' })
    const otherKind = await call(owner.cookies, 'POST', url, { field: 'password' })
    expect(absent.statusCode).toBe(422)
    expect(otherKind.statusCode).toBe(422)
    expect(otherKind.json()).toEqual(absent.json())
    expect(otherKind.body).not.toContain('hunter2')

    const missing = await call(
      owner.cookies,
      'POST',
      `/api/v1/projects/${projectId}/credentials/${randomUUID()}/totp`,
      { field: AUTHENTICATOR }
    )
    expect(missing.statusCode).toBe(404)
    expect(await auditRows(owner.orgId, REVEALED, id)).toHaveLength(0)

    const bad = await call(owner.cookies, 'POST', url, { field: 'a', extra: 1 })
    expect(bad.statusCode).toBe(422)
  }, 60_000)

  it('denies a project viewer and a non-member exactly as the reveal does, with no audit row', async () => {
    const owner = await registerOwner(app, 'deny-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-deny')
    const id = (await createLogin(owner.cookies, projectId)).json<{ data: { id: string } }>().data
      .id
    const url = `/api/v1/projects/${projectId}/credentials/${id}/totp`
    const viewer = await addUserToOrg(app, owner.orgId, 'deny-viewer', { orgRole: 'member' })
    await addProjectMember(owner.orgId, projectId, viewer.userId, 'viewer')
    const outsider = await addUserToOrg(app, owner.orgId, 'deny-outsider', { orgRole: 'member' })

    const asViewer = await call(viewer.cookies, 'POST', url, { field: AUTHENTICATOR })
    expect(asViewer.statusCode).toBe(403)
    const asOutsider = await call(outsider.cookies, 'POST', url, { field: AUTHENTICATOR })
    const unknown = await call(
      outsider.cookies,
      'POST',
      `/api/v1/projects/${projectId}/credentials/${randomUUID()}/totp`,
      { field: AUTHENTICATOR }
    )
    expect(asOutsider.statusCode).toBe(404)
    expect(asOutsider.json()).toEqual(unknown.json())
    expect(await auditRows(owner.orgId, REVEALED, id)).toHaveLength(0)
  }, 60_000)

  it('keeps the seed when an edit sends it empty, replaces it when a new one is sent, and rejects a bad one', async () => {
    const owner = await registerOwner(app, 'edit-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-edit')
    const id = (await createLogin(owner.cookies, projectId)).json<{ data: { id: string } }>().data
      .id
    const versions = `/api/v1/projects/${projectId}/credentials/${id}/versions`
    const totpUrl = `/api/v1/projects/${projectId}/credentials/${id}/totp`
    const edit = (seed: string) => ({
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'authenticator', value: seed, sensitive: true, kind: 'totp' },
      ],
    })

    const kept = await call(owner.cookies, 'POST', versions, edit(''))
    expect(kept.statusCode).toBe(201)
    const keptCode = await call(owner.cookies, 'POST', totpUrl, { field: AUTHENTICATOR })
    expect(keptCode.statusCode).toBe(200)
    expect(keptCode.json<{ data: { field: string; versionNumber: number } }>().data).toMatchObject({
      field: 'authenticator',
      versionNumber: 2,
    })

    const bad = await call(owner.cookies, 'POST', versions, edit('not a seed 1890!'))
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ code: 'invalid_totp_seed' })
    expect(bad.body).not.toContain('not a seed 1890!')

    const replaced = await call(owner.cookies, 'POST', versions, edit(NEW_SEED))
    expect(replaced.statusCode).toBe(201)

    const rows = await auditRows(owner.orgId, 'credential.version_created', id)
    const serialized = JSON.stringify(rows)
    for (const secret of [SEED, NEW_SEED]) expect(serialized).not.toContain(secret)
    const latest = rows.find(
      (row) => (row.payload as { versionNumber?: number }).versionNumber === 3
    )
    expect(latest?.payload).toMatchObject({ changedFields: ['authenticator'] })
  }, 60_000)

  it('rejects a create whose totp field has no seed or an invalid one, writing nothing', async () => {
    const owner = await registerOwner(app, 'create-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-create')
    const empty = await createLogin(owner.cookies, projectId, '')
    expect(empty.statusCode).toBe(422)
    expect(empty.json()).toMatchObject({ code: 'totp_seed_required' })
    const bad = await createLogin(owner.cookies, projectId, 'nope!')
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ code: 'invalid_totp_seed' })
    const list = await call(owner.cookies, 'GET', `/api/v1/projects/${projectId}/credentials`)
    expect(list.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(0)
  }, 60_000)

  it('withholds the seed from the project export but keeps the field', async () => {
    const owner = await registerOwner(app, 'export-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-export')
    expect((await createLogin(owner.cookies, projectId)).statusCode).toBe(201)

    const { bundle } = await withOrg(owner.orgId, (tx) =>
      buildExportBundle(tx, { orgId: owner.orgId, projectId })
    )
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(SEED)
    expect(serialized).toContain('hunter2-not-a-real-one')
    const stored = bundle.credentials[0]?.versions[0]
    const fields = JSON.parse(stored?.value ?? '[]') as Array<Record<string, unknown>>
    expect(fields.find((entry) => entry['kind'] === 'totp')).toEqual({
      key: 'Authenticator',
      value: '',
      sensitive: true,
      kind: 'totp',
    })
  }, 60_000)

  it('has its own per-user rate-limit bucket, separate from the reveal bucket', async () => {
    const owner = await registerOwner(app, 'ratelimit-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'totp-ratelimit')
    const id = (await createLogin(owner.cookies, projectId)).json<{ data: { id: string } }>().data
      .id
    const viewer = await addUserToOrg(app, owner.orgId, 'ratelimit-viewer', { orgRole: 'member' })
    await addProjectMember(owner.orgId, projectId, viewer.userId, 'viewer')
    const url = `/api/v1/projects/${projectId}/credentials/${id}/totp`

    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    // The project-role denial happens after the limiter, so each attempt spends the viewer's
    // bucket without decrypting anything.
    const statuses: number[] = []
    for (let attempt = 0; attempt < 61; attempt += 1) {
      statuses.push((await call(viewer.cookies, 'POST', url, { field: AUTHENTICATOR })).statusCode)
    }
    expect(statuses.slice(0, 60).every((status) => status === 403)).toBe(true)
    expect(statuses[60]).toBe(429)

    // The same user's reveal bucket and another user's code bucket are untouched.
    const reveal = await call(
      viewer.cookies,
      'GET',
      `/api/v1/projects/${projectId}/credentials/${id}/value`
    )
    expect(reveal.statusCode).toBe(403)
    const ownerCode = await call(owner.cookies, 'POST', url, { field: AUTHENTICATOR })
    expect(ownerCode.statusCode).toBe(200)
  }, 120_000)
})
