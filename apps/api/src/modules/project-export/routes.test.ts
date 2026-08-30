import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialVersions,
  credentials,
  projects,
  rotations,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import {
  createCredentialTestProject,
  createCredentialViaApi,
  SENTINEL_VALUE,
} from '../credentials/credential-route-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'project-export-routes-passphrase-a'
const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'project-export',
  orgNamePrefix: 'Project Export Org',
})

function exportUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/export`
}
const IMPORT_URL = '/api/v1/projects/import'

async function callExport(app: TestApp, cookies: Record<string, string>, projectId: string) {
  return app.inject({
    method: 'POST',
    url: exportUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
  })
}

// The shared `FastifyInjectResponse` test-facade type only declares `statusCode`/`headers`/
// `json()` — the underlying light-my-request response also carries the raw response body
// (`.rawPayload`, a Buffer), needed here since export's 200 body is binary, not JSON. Cast
// locally (matching this repo's existing `export-routes.test.ts` convention for its own binary
// CSV-download assertions) rather than widening the shared facade type for every other caller.
function rawBody(response: unknown): Buffer {
  return (response as { rawPayload: Buffer }).rawPayload
}

function buildImportPayload(fileBuffer: Buffer, exportKey: string, projectName?: string): Buffer {
  const boundary = '----pvexporttestboundary'
  const parts: string[] = []
  parts.push(`--${boundary}\r\n`)
  parts.push(`Content-Disposition: form-data; name="exportKey"\r\n\r\n${exportKey}\r\n`)
  if (projectName) {
    parts.push(`--${boundary}\r\n`)
    parts.push(`Content-Disposition: form-data; name="projectName"\r\n\r\n${projectName}\r\n`)
  }
  parts.push(`--${boundary}\r\n`)
  parts.push(`Content-Disposition: form-data; name="file"; filename="export.pvexport"\r\n`)
  parts.push(`Content-Type: application/octet-stream\r\n\r\n`)
  const head = Buffer.from(parts.join(''), 'utf8')
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return Buffer.concat([head, fileBuffer, tail])
}

async function callImport(
  app: TestApp,
  cookies: Record<string, string>,
  fileBuffer: Buffer,
  exportKey: string,
  projectName?: string
) {
  const boundary = '----pvexporttestboundary'
  const payload = buildImportPayload(fileBuffer, exportKey, projectName)
  return app.inject({
    method: 'POST',
    url: IMPORT_URL,
    headers: {
      cookie: cookieHeader(cookies),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  })
}

describe('project-export routes (Story 28.9)', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  async function createFixture(label: string) {
    const owner = await registerOwner(app, label)
    const projectId = await createCredentialTestProject(app, owner.cookies, label)
    const credential = await createCredentialViaApi(app, owner.cookies, projectId)
    return { owner, projectId, credentialId: credential.id }
  }

  it('AC-1: exports a project as an encrypted file + one-time key in the same response', async () => {
    const { owner, projectId } = await createFixture('happy')

    const response = await callExport(app, owner.cookies, projectId)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(String(response.headers['content-disposition'])).toContain('.pvexport')
    const exportKey = response.headers['x-export-key']
    expect(typeof exportKey).toBe('string')
    expect((exportKey as string).length).toBeGreaterThan(20)
    expect(rawBody(response).length).toBeGreaterThan(0)
  })

  it('AC-1 negative: a project viewer without org admin/owner cannot export (403, no key generated)', async () => {
    const { owner, projectId } = await createFixture('insufficient')
    const viewer = await addUserToOrg(app, owner.orgId, 'insufficient-viewer', {
      orgRole: 'member',
    })
    await addProjectMember(owner.orgId, projectId, viewer.userId, 'viewer')

    const response = await callExport(app, viewer.cookies, projectId)

    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('project_export_requires_admin')
    expect(response.headers['x-export-key']).toBeUndefined()
  })

  it('AC-1: org admin can export even without an explicit project membership', async () => {
    const { owner, projectId } = await createFixture('org-admin')
    const orgAdmin = await addUserToOrg(app, owner.orgId, 'org-admin', { orgRole: 'admin' })

    const response = await callExport(app, orgAdmin.cookies, projectId)

    expect(response.statusCode).toBe(200)
  })

  it('AC-2: writes a project.export_created audit entry with entity counts, never the key or a secret value', async () => {
    const { owner, projectId } = await createFixture('audit')

    const response = await callExport(app, owner.cookies, projectId)
    const exportKey = response.headers['x-export-key'] as string

    const audit = await withOrg(owner.orgId, (tx) =>
      tx
        .select()
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'project.export_created'))
    )
    const entry = audit.find((row) => row.resourceId === projectId)
    expect(entry).toBeDefined()
    const payloadJson = JSON.stringify(entry?.payload ?? {})
    expect(payloadJson).not.toContain(exportKey)
    expect(payloadJson).not.toContain(SENTINEL_VALUE)
    expect((entry?.payload as Record<string, unknown>)?.['credentials']).toBe(1)
  })

  it('AC-3/AC-4/AC-5: imports as a brand-new project (never a merge) and round-trips the decrypted secret value under a DIFFERENT live master key', async () => {
    const { owner, projectId, credentialId } = await createFixture('roundtrip')
    const exportResponse = await callExport(app, owner.cookies, projectId)
    expect(exportResponse.statusCode).toBe(200)
    const exportKey = exportResponse.headers['x-export-key'] as string
    const fileBuffer = rawBody(exportResponse)

    // AC-5: re-seal and re-unseal the SAME running instance with a DIFFERENT passphrase — this
    // derives a genuinely different live master key, mirroring "import into a vault instance
    // seeded under a different master key." The export file is self-contained (D2/D3): nothing
    // about the import below depends on the exporting org's own master key or its still-live
    // credential rows.
    await app.close()
    await resetVaultForTest()
    await initVaultForTest(initVault, 'project-export-routes-passphrase-B-different')
    app = await createApp({ logger: false, vaultGuardEnabled: true })

    const importer = await registerOwner(app, 'importer')
    const importResponse = await callImport(app, importer.cookies, fileBuffer, exportKey)

    expect(importResponse.statusCode).toBe(201)
    const body = importResponse.json<{
      data: { projectId: string; name: string; importedCounts: Record<string, number> }
    }>()
    // AC-4: a genuinely new project, never the source project id.
    expect(body.data.projectId).not.toBe(projectId)
    expect(body.data.importedCounts.credentials).toBe(1)

    const [importedProjectRow] = await withOrg(importer.orgId, (tx) =>
      tx.select().from(projects).where(eq(projects.id, body.data.projectId))
    )
    expect(importedProjectRow?.orgId).toBe(importer.orgId)

    // AC-5: the secret round-trips correctly even though it was decrypted under org A's master
    // key at export and re-encrypted under this new instance's DIFFERENT master key at import.
    const [importedCredentialRow] = await withOrg(importer.orgId, (tx) =>
      tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(eq(credentials.projectId, body.data.projectId))
    )
    const valueResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${body.data.projectId}/credentials/${importedCredentialRow?.id}/value`,
      headers: { cookie: cookieHeader(importer.cookies) },
    })
    expect(valueResponse.statusCode).toBe(200)
    const valueBody = valueResponse.json<{ data: { value?: string } }>()
    expect(valueBody.data.value).toBe(SENTINEL_VALUE)
    void credentialId
  })

  it('AC-3 negative: wrong export key fails to decrypt (401, no oracle)', async () => {
    const { owner, projectId } = await createFixture('wrongkey')
    const exportResponse = await callExport(app, owner.cookies, projectId)
    const importer = await registerOwner(app, 'wrongkey-importer')

    const response = await callImport(
      app,
      importer.cookies,
      rawBody(exportResponse),
      'wrong-key-not-the-real-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )

    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('import_decrypt_failed')
  })

  it('AC-3 negative: unsupported exportFormatVersion is rejected before any other field is read (422)', async () => {
    const importer = await registerOwner(app, 'badversion-importer')
    const { encryptBundleUnderExportKey, generateExportKey } = await import('./service.js')
    const rawKey = generateExportKey()
    const encrypted = await encryptBundleUnderExportKey(
      {
        exportFormatVersion: 2 as never,
        project: { name: 'x', description: null, tags: [] },
        credentials: [],
        credentialDependencies: [],
        rotations: [],
        certRecords: [],
        domainRecords: [],
        serviceEndpoints: [],
        statusPages: [],
        machineUsers: [],
      },
      rawKey
    )
    const fileBuffer = Buffer.from(JSON.stringify(encrypted), 'utf8')

    const response = await callImport(app, importer.cookies, fileBuffer, rawKey)

    expect(response.statusCode).toBe(422)
    expect(response.json<{ code: string }>().code).toBe('unsupported_export_format')
  })

  it('AC-6: an in_progress rotation at export time never reads as in_progress after import (D5)', async () => {
    const { owner, projectId, credentialId } = await createFixture('rotation-status')
    const [versionRow] = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: credentialVersions.id })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, credentialId))
    )
    const versionId = versionRow?.id as string
    await withOrg(owner.orgId, (tx) =>
      tx.insert(rotations).values({
        orgId: owner.orgId,
        projectId,
        credentialId,
        newVersionId: versionId,
        previousVersionId: versionId,
        status: 'in_progress',
        initiatedAt: new Date(),
      })
    )

    const exportResponse = await callExport(app, owner.cookies, projectId)
    expect(exportResponse.statusCode).toBe(200)
    const exportKey = exportResponse.headers['x-export-key'] as string

    const { decryptExportFile, parseExportBundle } = await import('./import-service.js')
    const decrypted = await decryptExportFile(rawBody(exportResponse), exportKey)
    expect(decrypted.status).toBe('ok')
    if (decrypted.status !== 'ok') return
    const parsed = parseExportBundle(JSON.parse(decrypted.plaintext))
    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') return
    for (const rotation of parsed.bundle.rotations) {
      expect(rotation.status).not.toBe('in_progress')
    }
  })

  it('AC-7: the exported (decrypted) payload never contains a credential_shares-derived field', async () => {
    const { owner, projectId } = await createFixture('no-shares')
    const exportResponse = await callExport(app, owner.cookies, projectId)
    const exportKey = exportResponse.headers['x-export-key'] as string

    const { decryptExportFile } = await import('./import-service.js')
    const decrypted = await decryptExportFile(rawBody(exportResponse), exportKey)
    expect(decrypted.status).toBe('ok')
    if (decrypted.status !== 'ok') return
    const json = JSON.parse(decrypted.plaintext) as Record<string, unknown>
    for (const key of Object.keys(json)) {
      expect(key.toLowerCase()).not.toContain('share')
    }
  })

  it('AC-10: export is rate-limited to 5/hour per user', async () => {
    // This dev environment's .env sets RATE_LIMIT_TEST_BYPASS=true by default (every other
    // route's own rate-limit behavior is exercised the same way — see backup.routes.test.ts) —
    // toggle it off just for this assertion, then restore whatever it was.
    const original = process.env['RATE_LIMIT_TEST_BYPASS']
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      const { owner, projectId } = await createFixture('rate-limit')
      for (let i = 0; i < 5; i++) {
        const response = await callExport(app, owner.cookies, projectId)
        expect(response.statusCode).toBe(200)
      }
      const sixth = await callExport(app, owner.cookies, projectId)
      expect(sixth.statusCode).toBe(429)
    } finally {
      if (original === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
      else process.env['RATE_LIMIT_TEST_BYPASS'] = original
    }
  })

  it("AC-9: export/import are scoped to the caller's own org — a second org cannot export a project it does not own", async () => {
    const { projectId } = await createFixture('tenant-a')
    const foreignOwner = await registerOwner(app, 'tenant-b')

    const response = await callExport(app, foreignOwner.cookies, projectId)

    expect(response.statusCode).toBe(404)
  })
})
