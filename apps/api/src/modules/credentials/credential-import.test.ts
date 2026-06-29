import { randomUUID } from 'node:crypto'
import FormData from 'form-data'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialDependencies,
  credentialVersions,
  credentials,
  pendingImports,
} from '@project-vault/db/schema'
import {
  bootstrapCredentialRouteOwners,
  confirmCredentialImport,
  createCredentialTestProject,
  createCredentialViaApi,
  credentialImportUrl,
  SENTINEL_VALUE,
  uploadCredentialImport,
} from './credential-route-test-helpers.js'
import { cookieHeader, expectAuditWriteFailed } from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createDirectAuthenticatedUser,
  loginExistingUserInOrg,
} from '../../__tests__/helpers/org-role-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  credentialIntegration,
  type CredentialRegisteredUser,
  type CredentialTestApp,
  CREDENTIAL_INTEGRATION_PASSWORD,
  FORCED_AUDIT_FAILURE,
} from './credential-integration-context.js'

const { createApp, initVault, humanAudit } = credentialIntegration

type TestApp = CredentialTestApp
type RegisteredUser = CredentialRegisteredUser

const TEST_PASSPHRASE = 'credential-import-passphrase'
const PASSWORD = CREDENTIAL_INTEGRATION_PASSWORD
const MONTHLY_ROTATION_CRON = '0 3 1 * *'

async function credentialAuditRows(orgId: string, eventType: string, resourceId?: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({ eventType: auditLogEntries.eventType, payload: auditLogEntries.payload })
      .from(auditLogEntries)
      .where(
        resourceId
          ? and(
              eq(auditLogEntries.eventType, eventType),
              eq(auditLogEntries.resourceId, resourceId)
            )
          : eq(auditLogEntries.eventType, eventType)
      )
  )
}

describe.sequential('credential bulk import routes', () => {
  let app: TestApp
  let owner: RegisteredUser
  let other: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner, other } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'import'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('POST import parses .env file with conflict detection and redacted preview', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'env-import')
    const existing = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'STRIPE_SECRET_KEY',
      value: 'existing-secret',
    })

    const res = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      'STRIPE_SECRET_KEY=sk_live_new\nDATABASE_URL=postgres://new\nMISSING_EQUALS\n',
      'production.env'
    )
    expect(res.statusCode).toBe(201)
    const body = res.json<{
      data: {
        importId: string
        itemCount: number
        parsed: Array<{
          name: string
          value: string
          conflictsWith: string | null
          suggestedAction: string
        }>
        warnings: Array<{ reason: string; line: number }>
      }
    }>()
    expect(body.data.itemCount).toBe(2)
    expect(body.data.parsed.every((item) => item.value === '[REDACTED]')).toBe(true)
    const conflict = body.data.parsed.find((item) => item.name === 'STRIPE_SECRET_KEY')
    expect(conflict).toMatchObject({
      conflictsWith: existing.id,
      suggestedAction: 'new_version',
    })
    expect(body.data.parsed.find((item) => item.name === 'DATABASE_URL')).toMatchObject({
      conflictsWith: null,
      suggestedAction: 'create_new',
    })
    expect(body.data.warnings.some((w) => w.reason === 'no_equals_sign')).toBe(true)

    const auditRows = await credentialAuditRows(
      owner.orgId,
      'credential.bulk_import_initiated',
      projectId
    )
    expect(
      auditRows.some(
        (row) => (row.payload as { importId?: string })?.importId === body.data.importId
      )
    ).toBe(true)
    expect(JSON.stringify(auditRows)).not.toContain('sk_live_new')
  }, 20_000)

  it('POST import parses JSON and rejects nested values', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'json-import')
    const ok = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      JSON.stringify({ PORT: 3000, DEBUG: true }),
      'secrets.json'
    )
    expect(ok.statusCode).toBe(201)
    expect(ok.json<{ data: { itemCount: number } }>().data.itemCount).toBe(2)

    const bad = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      JSON.stringify({ KEY: { nested: true } }),
      'bad.json'
    )
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ code: 'nested_value' })
  }, 20_000)

  it('enforces file validation limits and unknown fields', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'import-limits')

    const unsupported = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      'x=1',
      'data.csv'
    )
    expect(unsupported.statusCode).toBe(422)
    expect(unsupported.json()).toMatchObject({ code: 'unsupported_file_type' })

    const tooMany = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      Array.from({ length: 501 }, (_, i) => `K${i}=v`).join('\n'),
      'big.env'
    )
    expect(tooMany.statusCode).toBe(422)
    expect(tooMany.json()).toMatchObject({ code: 'import_too_large', limit: 500, found: 501 })

    const boundary = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      Array.from({ length: 500 }, (_, i) => `K${i}=v`).join('\n'),
      'boundary.env'
    )
    expect(boundary.statusCode).toBe(201)

    const missingNameForm = new FormData()
    missingNameForm.append('file', Buffer.from('KEY=value', 'utf8'))
    const missingName = await app.inject({
      method: 'POST',
      url: credentialImportUrl(projectId),
      headers: {
        cookie: cookieHeader(owner.cookies),
        ...missingNameForm.getHeaders(),
      },
      payload: missingNameForm,
    })
    expect(missingName.statusCode).toBe(422)
    expect(missingName.json()).toMatchObject({ code: 'missing_filename' })

    const extraFieldForm = new FormData()
    extraFieldForm.append('extra', 'nope')
    extraFieldForm.append('file', Buffer.from('KEY=value', 'utf8'), {
      filename: 'test.env',
      contentType: 'text/plain',
    })
    const extraField = await app.inject({
      method: 'POST',
      url: credentialImportUrl(projectId),
      headers: { cookie: cookieHeader(owner.cookies), ...extraFieldForm.getHeaders() },
      payload: extraFieldForm,
    })
    expect(extraField.statusCode).toBe(422)
    expect(extraField.json()).toMatchObject({ code: 'unknown_field' })
  }, 30_000)

  it('denies member/viewer and returns 404 for foreign project', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'import-auth')
    const member = await createDirectAuthenticatedUser(app, 'import-member', 'member', 'import')
    const viewer = await createDirectAuthenticatedUser(app, 'import-viewer', 'viewer', 'import')
    const adminCookies = await loginExistingUserInOrg(app, {
      userId: member.userId,
      orgId: owner.orgId,
      role: 'admin',
    })

    expect(
      (await uploadCredentialImport(app, member.cookies, projectId, 'KEY=v', 'x.env')).statusCode
    ).toBe(403)
    expect(
      (await uploadCredentialImport(app, viewer.cookies, projectId, 'KEY=v', 'x.env')).statusCode
    ).toBe(403)
    expect(
      (await uploadCredentialImport(app, adminCookies, projectId, 'KEY=v', 'x.env')).statusCode
    ).toBe(201)

    const foreignProject = await createCredentialTestProject(app, other.cookies, 'foreign-import')
    expect(
      (await uploadCredentialImport(app, owner.cookies, foreignProject, 'KEY=v', 'x.env'))
        .statusCode
    ).toBe(404)
  }, 20_000)

  it('confirm applies new_version, create_new, and skip with metadata preserved', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'confirm-mixed')
    const existing = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'STRIPE_SECRET_KEY',
      value: 'old-stripe',
      tags: ['payments'],
      rotationSchedule: MONTHLY_ROTATION_CRON,
      expiresAt: '2026-12-31T23:59:59.000Z',
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${existing.id}/dependencies`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { systemName: 'billing-worker' },
    })

    const preview = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      'STRIPE_SECRET_KEY=rotated\nDATABASE_URL=postgres://new\nOLD_UNUSED_KEY=unused\nAPI_KEY=fresh\n',
      'confirm.env'
    )
    const importId = preview.json<{ data: { importId: string } }>().data.importId

    const confirm = await confirmCredentialImport(app, owner.cookies, projectId, {
      importId,
      defaultAction: 'new_version',
      overrides: { DATABASE_URL: 'create_new', OLD_UNUSED_KEY: 'skip' },
    })
    expect(confirm.statusCode).toBe(200)
    const result = confirm.json<{
      data: {
        imported: number
        newVersions: number
        skipped: number
        results: Array<{ name: string; action: string; credentialId: string | null }>
      }
    }>().data
    expect(result.skipped).toBe(1)
    expect(result.newVersions).toBeGreaterThanOrEqual(1)

    const [updatedCred] = await withOrg(owner.orgId, (tx) =>
      tx.select().from(credentials).where(eq(credentials.id, existing.id))
    )
    expect(updatedCred?.tags).toEqual(['payments'])
    expect(updatedCred?.rotationSchedule).toBe(MONTHLY_ROTATION_CRON)
    expect(updatedCred?.expiresAt?.toISOString()).toBe('2026-12-31T23:59:59.000Z')

    const deps = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(credentialDependencies)
        .where(eq(credentialDependencies.credentialId, existing.id))
    )
    expect(deps).toHaveLength(1)

    const versions = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ versionNumber: credentialVersions.versionNumber })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, existing.id))
        .orderBy(credentialVersions.versionNumber)
    )
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2])

    const pending = await withOrg(owner.orgId, (tx) =>
      tx.select().from(pendingImports).where(eq(pendingImports.id, importId))
    )
    expect(pending).toHaveLength(0)
  }, 30_000)

  it('create_new on conflicting item uses imported suffix', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'suffix-import')
    await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'DUPLICATE_KEY',
      value: 'existing',
    })

    const preview = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      'DUPLICATE_KEY=new-value\n',
      'dup.env'
    )
    const importId = preview.json<{ data: { importId: string } }>().data.importId
    const confirm = await confirmCredentialImport(app, owner.cookies, projectId, {
      importId,
      defaultAction: 'create_new',
    })
    expect(confirm.statusCode).toBe(200)

    const names = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ name: credentials.name })
        .from(credentials)
        .where(eq(credentials.projectId, projectId))
    )
    expect(names.some((row) => row.name === 'DUPLICATE_KEY')).toBe(true)
    expect(names.some((row) => /DUPLICATE_KEY_imported_\d+_0$/.test(row.name))).toBe(true)
  }, 20_000)

  it('returns 410 for expired import and 404 for unknown importId', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'import-expiry')
    const [expiredRow] = await withOrg(owner.orgId, (tx) =>
      tx
        .insert(pendingImports)
        .values({
          orgId: owner.orgId,
          projectId,
          createdBy: owner.userId,
          fileType: 'env',
          itemCount: 0,
          items: [],
          warnings: [],
          expiresAt: new Date(Date.now() - 60_000),
        })
        .returning({ id: pendingImports.id })
    )

    expect(expiredRow).toBeDefined()
    if (!expiredRow) return

    const expired = await confirmCredentialImport(app, owner.cookies, projectId, {
      importId: expiredRow.id,
      defaultAction: 'skip',
    })
    expect(expired.statusCode).toBe(410)
    expect(expired.json()).toMatchObject({ code: 'import_expired' })

    const missing = await confirmCredentialImport(app, owner.cookies, projectId, {
      importId: randomUUID(),
      defaultAction: 'skip',
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'import_not_found' })
  }, 20_000)

  it('never returns plaintext values in import responses (sentinel scan)', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'sentinel-import')
    await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'SENTINEL_KEY',
      value: SENTINEL_VALUE,
    })

    const preview = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      `SENTINEL_KEY=${SENTINEL_VALUE}\n`,
      'sentinel.env'
    )
    expect(JSON.stringify(preview.json())).not.toContain(SENTINEL_VALUE)

    const importId = preview.json<{ data: { importId: string } }>().data.importId
    const confirm = await confirmCredentialImport(app, owner.cookies, projectId, {
      importId,
      defaultAction: 'new_version',
    })
    expect(JSON.stringify(confirm.json())).not.toContain(SENTINEL_VALUE)
  }, 20_000)

  it('rolls back confirm when audit write fails', async () => {
    const projectId = await createCredentialTestProject(app, owner.cookies, 'audit-rollback')
    const preview = await uploadCredentialImport(
      app,
      owner.cookies,
      projectId,
      'ROLLBACK_KEY=secret-value\n',
      'rollback.env'
    )
    const importId = preview.json<{ data: { importId: string } }>().data.importId

    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValue(new Error(FORCED_AUDIT_FAILURE))
    try {
      const failed = await confirmCredentialImport(app, owner.cookies, projectId, {
        importId,
        defaultAction: 'create_new',
      })
      expectAuditWriteFailed(failed)

      const creds = await withOrg(owner.orgId, (tx) =>
        tx.select().from(credentials).where(eq(credentials.projectId, projectId))
      )
      expect(creds).toHaveLength(0)

      const pending = await withOrg(owner.orgId, (tx) =>
        tx.select().from(pendingImports).where(eq(pendingImports.id, importId))
      )
      expect(pending).toHaveLength(1)
    } finally {
      auditSpy.mockRestore()
    }
  }, 20_000)
})
