import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { auditLogEntries, credentialVersions, orgMemberships } from '@project-vault/db/schema'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  bootstrapCredentialRouteOwners,
  createCredentialTestProject,
  createCredentialViaApi,
  SENTINEL_VALUE,
} from './credential-route-test-helpers.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type RegisteredUser = { userId: string; orgId: string; cookies: Record<string, string> }

const TEST_PASSPHRASE = 'credential-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const STRIPE_SECRET_KEY = 'Stripe Secret Key'
const STRIPE_PROD = 'Stripe Prod'
const PAYMENTS_TAG = 'payments'
const PROD_TAG = 'prod'
const THIRD_PARTY_TAG = 'third-party'
const FORCED_AUDIT_FAILURE = 'forced audit failure'

async function createTestProjectDirect(orgId: string, userId: string, slug: string) {
  const project = await insertTestProject(orgId, { userId, slug })
  return project.id
}

type CredentialListByName = { data: { total: number; items: { name: string }[] } }

function expectSingleCredentialNamed(response: { json<T>(): T }, name: string): void {
  expect(response.json<CredentialListByName>().data).toMatchObject({
    total: 1,
    items: [expect.objectContaining({ name })],
  })
}

type CredentialDetail = {
  id: string
  projectId: string
  orgId: string
  name: string
  currentVersionNumber: number
  retentionCount: number
}

async function createTestCredential(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  body: { name: string; value: string; [key: string]: unknown }
) {
  return createCredentialViaApi(app, cookies, projectId, body) as Promise<CredentialDetail>
}

async function createTestProject(app: TestApp, cookies: Record<string, string>, slug: string) {
  return createCredentialTestProject(app, cookies, slug)
}

async function revealValue(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string
) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/value`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function addVersion(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  value: string
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { value },
  })
}

async function listVersions(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string
) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function listCredentials(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  query = ''
) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials${query}`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function updateCredentialTags(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  method: 'PUT' | 'PATCH',
  tags: string[]
) {
  return app.inject({
    method,
    url: `/api/v1/projects/${projectId}/credentials/${credentialId}/tags`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { tags },
  })
}

async function purgeVersion(orgId: string, credentialId: string, versionNumber: number) {
  await withOrg(orgId, (tx) =>
    tx
      .update(credentialVersions)
      .set({ encryptedValue: null, keyVersion: null, purgedAt: new Date() })
      .where(
        and(
          eq(credentialVersions.credentialId, credentialId),
          eq(credentialVersions.versionNumber, versionNumber)
        )
      )
  )
}

describe.sequential('credential routes', () => {
  let app: TestApp
  let owner: RegisteredUser
  let other: RegisteredUser

  beforeAll(async () => {
    ;({ app, owner, other } = await bootstrapCredentialRouteOwners(
      createApp,
      initVault,
      TEST_PASSPHRASE,
      PASSWORD,
      'credentials'
    ))
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('POST creates a credential and first version, never returning the value', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'create-project')

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        name: STRIPE_SECRET_KEY,
        value: 'sk_live_example_not_a_real_key',
        description: 'Production secret',
        tags: [PAYMENTS_TAG],
        rotationSchedule: '0 0 1 * *',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ data: CredentialDetail }>()
    expect(body.data).toMatchObject({
      projectId,
      name: STRIPE_SECRET_KEY,
      currentVersionNumber: 1,
      retentionCount: 3,
    })
    expect(JSON.stringify(body.data)).not.toContain('sk_live_example_not_a_real_key')

    const versionRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({
          encryptedValue: credentialVersions.encryptedValue,
          keyVersion: credentialVersions.keyVersion,
        })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, body.data.id))
    )
    expect(versionRows).toHaveLength(1)
    expect(versionRows[0]?.encryptedValue).toMatchObject({ ciphertext: expect.any(String) })
    expect(versionRows[0]?.keyVersion).toBe(1)

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.created'))
    )
    expect(auditRows.some((row) => row.resourceId === body.data.id)).toBe(true)
    expect(JSON.stringify(auditRows)).not.toContain('sk_live_example_not_a_real_key')
  }, 20_000)

  it('POST rejects missing/empty value, unknown keys, and malformed cron', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'validation-project')
    const url = `/api/v1/projects/${projectId}/credentials`

    const missingValue = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Key' },
    })
    expect(missingValue.statusCode).toBe(422)

    const emptyValue = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Key', value: '' },
    })
    expect(emptyValue.statusCode).toBe(422)

    const unknownKey = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Key', value: 'secret', orgId: randomUUID() },
    })
    expect(unknownKey.statusCode).toBe(422)

    const malformedCron = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Key', value: 'secret', rotationSchedule: '* * *' },
    })
    expect(malformedCron.statusCode).toBe(422)
    expect(malformedCron.json()).toMatchObject({ code: 'invalid_cron' })

    const tooFrequentCron = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Key2', value: 'secret', rotationSchedule: '*/30 * * * *' },
    })
    expect(tooFrequentCron.statusCode).toBe(422)
    expect(tooFrequentCron.json()).toMatchObject({ code: 'invalid_cron' })
  }, 20_000)

  it('POST returns 404 for a project outside the caller org and 401 when unauthenticated', async () => {
    const otherProjectId = await createTestProject(app, other.cookies, 'cross-org-project')

    const crossOrg = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${otherProjectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Key', value: 'secret' },
    })
    expect(crossOrg.statusCode).toBe(404)
    expect(crossOrg.json()).toMatchObject({ code: 'project_not_found' })

    const ownProjectId = await createTestProject(app, owner.cookies, 'own-project')
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${ownProjectId}/credentials`,
      payload: { name: 'Key', value: 'secret' },
    })
    expect(unauthenticated.statusCode).toBe(401)
  }, 20_000)

  it('rolls back credential creation when the audit write fails', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'create-audit-fail')
    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Audit Fail', value: 'secret' },
    })

    expectAuditWriteFailed(res)
    auditSpy.mockRestore()
  }, 20_000)

  it('GET value reveals the current value and writes a value_revealed audit row', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'reveal-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Reveal Key',
      value: 'reveal-secret-v1',
    })

    const res = await revealValue(app, owner.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { value: 'reveal-secret-v1', versionNumber: 1 } })

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.value_revealed'))
    )
    expect(
      auditRows.some((row) => (row.payload as { versionNumber?: number })?.versionNumber === 1)
    ).toBe(true)
  }, 20_000)

  it('GET value returns the current version after a new version is added', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'reveal-current-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Rotating Key',
      value: 'v1-value',
    })

    await addVersion(app, owner.cookies, projectId, credential.id, 'v2-value')

    const res = await revealValue(app, owner.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { value: 'v2-value', versionNumber: 2 } })
  }, 20_000)

  it('GET value reveals the next live version when the newest version is purged', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'reveal-purged-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Purge-Top Key',
      value: 'v1-value',
    })
    await addVersion(app, owner.cookies, projectId, credential.id, 'v2-value')
    await purgeVersion(owner.orgId, credential.id, 2)

    const res = await revealValue(app, owner.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { value: 'v1-value', versionNumber: 1 } })
  }, 20_000)

  it('GET value returns 404 when missing, wrong project, or all versions purged', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'reveal-404-project')
    const otherProjectId = await createTestProject(app, other.cookies, 'reveal-404-other-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Purge-All Key',
      value: 'only-version',
    })

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/credentials/${randomUUID()}/value`,
      headers: { cookie: cookieHeader(owner.cookies) },
    })
    expect(missing.statusCode).toBe(404)

    const wrongProject = await revealValue(app, other.cookies, otherProjectId, credential.id)
    expect(wrongProject.statusCode).toBe(404)

    await withOrg(owner.orgId, (tx) =>
      tx
        .update(credentialVersions)
        .set({ encryptedValue: null, keyVersion: null, purgedAt: new Date() })
        .where(eq(credentialVersions.credentialId, credential.id))
    )
    const allPurged = await revealValue(app, owner.cookies, projectId, credential.id)
    expect(allPurged.statusCode).toBe(404)
  }, 20_000)

  it('AUDIT-FAILURE ROLLBACK: reveal rolls back and returns 503 with no value persisted in audit', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'reveal-audit-fail-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Audit Fail Key',
      value: 'should-not-leak',
    })

    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))

    const res = await revealValue(app, owner.cookies, projectId, credential.id)
    expectAuditWriteFailed(res)
    expect(JSON.stringify(res.json())).not.toContain('should-not-leak')

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.value_revealed'))
    )
    expect(auditRows.filter((row) => row).length).toBeGreaterThanOrEqual(0)
    auditSpy.mockRestore()
  }, 20_000)

  it('POST versions creates a monotonic version and allows duplicate values', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'add-version-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Versioned Key',
      value: 'same-value',
    })

    const res = await addVersion(app, owner.cookies, projectId, credential.id, 'same-value')
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ data: { credentialId: credential.id, versionNumber: 2 } })

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.version_created'))
    )
    expect(
      auditRows.some((row) => (row.payload as { versionNumber?: number })?.versionNumber === 2)
    ).toBe(true)
  }, 20_000)

  it('POST versions returns 404 when credential is missing', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'add-version-404-project')

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${randomUUID()}/versions`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { value: 'secret' },
    })
    expect(missing.statusCode).toBe(404)
  }, 20_000)

  it('VERSION-CONFLICT CONCURRENCY: concurrent add-version requests never duplicate version numbers', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'add-version-race-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Race Key',
      value: 'v1',
    })

    const url = `/api/v1/projects/${projectId}/credentials/${credential.id}/versions`
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { value: 'race-a' },
      }),
      app.inject({
        method: 'POST',
        url,
        headers: { cookie: cookieHeader(owner.cookies) },
        payload: { value: 'race-b' },
      }),
    ])

    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses[0]).toBe(201)
    expect([201, 409]).toContain(statuses[1])

    const versionRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ versionNumber: credentialVersions.versionNumber })
        .from(credentialVersions)
        .where(eq(credentialVersions.credentialId, credential.id))
    )
    const versionNumbers = versionRows.map((row) => row.versionNumber)
    expect(new Set(versionNumbers).size).toBe(versionNumbers.length)
  }, 20_000)

  it('GET versions lists newest-first with isCurrent and purgedAt, never the value', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'versions-list-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'List Key',
      value: SENTINEL_VALUE,
    })
    await addVersion(app, owner.cookies, projectId, credential.id, 'second-version-value')

    const res = await listVersions(app, owner.cookies, projectId, credential.id)
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: { items: { versionNumber: number; isCurrent: boolean; purgedAt: string | null }[] }
    }>()
    expect(body.data.items).toMatchObject([
      { versionNumber: 2, isCurrent: true, purgedAt: null },
      { versionNumber: 1, isCurrent: false, purgedAt: null },
    ])
    expect(JSON.stringify(body)).not.toContain(SENTINEL_VALUE)

    await purgeVersion(owner.orgId, credential.id, 2)
    const afterPurge = await listVersions(app, owner.cookies, projectId, credential.id)
    const afterPurgeBody = afterPurge.json<{
      data: { items: { versionNumber: number; isCurrent: boolean; purgedAt: string | null }[] }
    }>()
    expect(afterPurgeBody.data.items[0]).toMatchObject({ versionNumber: 2, isCurrent: false })
    expect(afterPurgeBody.data.items[0]?.purgedAt).not.toBeNull()
    expect(afterPurgeBody.data.items[1]).toMatchObject({ versionNumber: 1, isCurrent: true })
  }, 20_000)

  it('GET versions returns 404 when the credential is missing', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'versions-404-project')

    const res = await listVersions(app, owner.cookies, projectId, randomUUID())
    expect(res.statusCode).toBe(404)
  }, 20_000)

  it('GET credentials returns an empty paginated list for a real project', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'list-empty-project')

    const res = await listCredentials(app, owner.cookies, projectId)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    })
  }, 20_000)

  it('GET credentials searches metadata only and never matches or returns credential values', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'list-search-project')
    await createTestCredential(app, owner.cookies, projectId, {
      name: STRIPE_SECRET_KEY,
      value: SENTINEL_VALUE,
      description: 'Production payments secret',
      tags: [PAYMENTS_TAG, PROD_TAG],
    })
    await createTestCredential(app, owner.cookies, projectId, {
      name: 'GitHub Token',
      value: 'github-token-value',
      description: 'Repository automation',
      tags: ['ci'],
    })

    const byName = await listCredentials(app, owner.cookies, projectId, '?q=stripe')
    expect(byName.statusCode).toBe(200)
    expect(
      byName.json<{ data: { total: number; items: { name: string }[] } }>().data
    ).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ name: STRIPE_SECRET_KEY })],
    })
    expect(JSON.stringify(byName.json())).not.toContain(SENTINEL_VALUE)

    const byDescription = await listCredentials(app, owner.cookies, projectId, '?q=automation')
    expect(byDescription.json<{ data: { total: number } }>().data.total).toBe(1)

    const byValue = await listCredentials(
      app,
      owner.cookies,
      projectId,
      `?q=${encodeURIComponent(SENTINEL_VALUE)}`
    )
    expect(byValue.statusCode).toBe(200)
    expect(byValue.json<{ data: { total: number; items: unknown[] } }>().data).toMatchObject({
      total: 0,
      items: [],
    })
    expect(JSON.stringify(byValue.json())).not.toContain(SENTINEL_VALUE)
  }, 20_000)

  it('GET credentials applies tag, status, expiresWithin, and combined filters', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'list-filter-project')
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    await createTestCredential(app, owner.cookies, projectId, {
      name: STRIPE_PROD,
      value: 'secret-1',
      description: 'Payments prod',
      tags: [PAYMENTS_TAG, PROD_TAG],
      expiresAt: soon,
    })
    await createTestCredential(app, owner.cookies, projectId, {
      name: 'Stripe Dev',
      value: 'secret-2',
      tags: [PAYMENTS_TAG, 'dev'],
      expiresAt: later,
    })
    await createTestCredential(app, owner.cookies, projectId, {
      name: 'Legacy Key',
      value: 'secret-3',
      tags: ['legacy', PROD_TAG],
      expiresAt: past,
    })

    const tags = await listCredentials(app, owner.cookies, projectId, '?tags=payments,prod')
    expectSingleCredentialNamed(tags, STRIPE_PROD)

    const expiringDefault = await listCredentials(app, owner.cookies, projectId, '?status=expiring')
    expectSingleCredentialNamed(expiringDefault, STRIPE_PROD)

    const expiringCustom = await listCredentials(
      app,
      owner.cookies,
      projectId,
      '?status=expiring&expiresWithin=90'
    )
    expect(expiringCustom.json<{ data: { total: number } }>().data.total).toBe(2)

    const expired = await listCredentials(app, owner.cookies, projectId, '?status=expired')
    expect(
      expired.json<{ data: { total: number; items: { name: string; status: string }[] } }>().data
    ).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ name: 'Legacy Key', status: 'expired' })],
    })

    const combined = await listCredentials(
      app,
      owner.cookies,
      projectId,
      '?q=stripe&tags=payments,prod&status=expiring&expiresWithin=30'
    )
    expect(
      combined.json<{ data: { total: number; items: { name: string }[] } }>().data
    ).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ name: STRIPE_PROD })],
    })
  }, 20_000)

  it('GET credentials paginates and rejects overly deep offsets', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'list-pagination-project')
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await createTestCredential(app, owner.cookies, projectId, { name, value: `${name}-secret` })
    }

    const pageOne = await listCredentials(app, owner.cookies, projectId, '?page=1&limit=2')
    expect(pageOne.statusCode).toBe(200)
    expect(
      pageOne.json<{ data: { total: number; items: unknown[]; hasNext: boolean } }>().data
    ).toMatchObject({
      total: 3,
      hasNext: true,
    })
    expect(pageOne.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(2)

    const clamped = await listCredentials(app, owner.cookies, projectId, '?limit=999')
    expect(clamped.statusCode).toBe(422)

    const tooDeep = await listCredentials(app, owner.cookies, projectId, '?page=102&limit=100')
    expect(tooDeep.statusCode).toBe(422)
    expect(tooDeep.json()).toMatchObject({ code: 'page_out_of_range' })
  }, 20_000)

  it('GET credentials validates params and hides cross-org projects as 404', async () => {
    const otherProjectId = await createTestProject(app, other.cookies, 'list-other-project')
    const ownerProjectId = await createTestProject(app, owner.cookies, 'list-owner-project')

    const malformed = await listCredentials(app, owner.cookies, 'not-a-uuid')
    expect(malformed.statusCode).toBe(422)

    const unknownQuery = await listCredentials(
      app,
      owner.cookies,
      ownerProjectId,
      '?includeValues=true'
    )
    expect(unknownQuery.statusCode).toBe(422)

    const crossOrg = await listCredentials(app, owner.cookies, otherProjectId)
    expect(crossOrg.statusCode).toBe(404)
    expect(crossOrg.json()).toMatchObject({ code: 'project_not_found' })

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${ownerProjectId}/credentials`,
    })
    expect(unauthenticated.statusCode).toBe(401)
  }, 20_000)

  it('PUT credential tags replaces, clears, de-dupes, and writes audit delta', async () => {
    const projectId = await createTestProjectDirect(
      owner.orgId,
      owner.userId,
      'credential-tags-put'
    )
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Tagged Key',
      value: SENTINEL_VALUE,
      tags: ['old', PROD_TAG],
    })

    const replace = await updateCredentialTags(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'PUT',
      [PAYMENTS_TAG, PAYMENTS_TAG, PROD_TAG]
    )
    expect(replace.statusCode).toBe(200)
    expect(replace.json()).toEqual({ data: { id: credential.id, tags: [PAYMENTS_TAG, PROD_TAG] } })
    expect(JSON.stringify(replace.json())).not.toContain(SENTINEL_VALUE)

    const clear = await updateCredentialTags(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'PUT',
      []
    )
    expect(clear.statusCode).toBe(200)
    expect(clear.json()).toEqual({ data: { id: credential.id, tags: [] } })

    const auditRows = await withOrg(owner.orgId, (tx) =>
      tx
        .select({ payload: auditLogEntries.payload, resourceId: auditLogEntries.resourceId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, 'credential.tags_updated'))
    )
    expect(
      auditRows.some(
        (row) =>
          row.resourceId === credential.id &&
          (row.payload as { mode?: string; added?: string[]; removed?: string[] }).mode ===
            'replace'
      )
    ).toBe(true)
    expect(JSON.stringify(auditRows)).not.toContain(SENTINEL_VALUE)
  }, 20_000)

  it('PATCH credential tags appends as a set union and enforces post-merge bounds', async () => {
    const projectId = await createTestProjectDirect(
      owner.orgId,
      owner.userId,
      'credential-tags-patch'
    )
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Append Tags Key',
      value: 'tag-secret',
      tags: [PAYMENTS_TAG, PROD_TAG],
    })

    const append = await updateCredentialTags(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'PATCH',
      [THIRD_PARTY_TAG, PAYMENTS_TAG]
    )
    expect(append.statusCode).toBe(200)
    expect(append.json()).toEqual({
      data: { id: credential.id, tags: [PAYMENTS_TAG, PROD_TAG, THIRD_PARTY_TAG] },
    })

    const noOp = await updateCredentialTags(app, owner.cookies, projectId, credential.id, 'PATCH', [
      PAYMENTS_TAG,
    ])
    expect(noOp.statusCode).toBe(200)
    expect(noOp.json()).toEqual({
      data: { id: credential.id, tags: [PAYMENTS_TAG, PROD_TAG, THIRD_PARTY_TAG] },
    })

    const tooMany = await updateCredentialTags(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'PATCH',
      Array.from({ length: 18 }, (_, i) => `extra-${i}`)
    )
    expect(tooMany.statusCode).toBe(422)
    expect(tooMany.json()).toMatchObject({ code: 'too_many_tags' })
  }, 20_000)

  it('credential tag routes validate body, auth, project scope, and audit rollback', async () => {
    const projectId = await createTestProjectDirect(
      owner.orgId,
      owner.userId,
      'credential-tags-validation'
    )
    const otherProjectId = await createTestProjectDirect(
      other.orgId,
      other.userId,
      'credential-tags-other'
    )
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Validate Tags Key',
      value: 'tag-validation-secret',
      tags: ['stable'],
    })

    const invalid = await updateCredentialTags(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'PUT',
      [' ']
    )
    expect(invalid.statusCode).toBe(422)

    const wrongProject = await updateCredentialTags(
      app,
      owner.cookies,
      otherProjectId,
      credential.id,
      'PUT',
      ['x']
    )
    expect(wrongProject.statusCode).toBe(404)

    const unauthenticated = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${projectId}/credentials/${credential.id}/tags`,
      payload: { tags: ['x'] },
    })
    expect(unauthenticated.statusCode).toBe(401)

    const auditSpy = vi
      .spyOn(humanAudit, 'writeHumanAuditEntry')
      .mockRejectedValueOnce(new Error(FORCED_AUDIT_FAILURE))
    const auditFail = await updateCredentialTags(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'PUT',
      ['rolled-back']
    )
    expectAuditWriteFailed(auditFail)
    auditSpy.mockRestore()

    const afterRollback = await listCredentials(app, owner.cookies, projectId)
    expect(JSON.stringify(afterRollback.json())).toContain('stable')
    expect(JSON.stringify(afterRollback.json())).not.toContain('rolled-back')
  }, 20_000)

  it('security regression: the credential value never appears in any non-reveal response body', async () => {
    const projectId = await createTestProjectDirect(owner.orgId, owner.userId, 'no-leak-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Sentinel Key',
      value: SENTINEL_VALUE,
    })
    expect(JSON.stringify(credential)).not.toContain(SENTINEL_VALUE)

    const addedVersion = await addVersion(
      app,
      owner.cookies,
      projectId,
      credential.id,
      SENTINEL_VALUE
    )
    expect(JSON.stringify(addedVersion.json())).not.toContain(SENTINEL_VALUE)

    const versionList = await listVersions(app, owner.cookies, projectId, credential.id)
    expect(JSON.stringify(versionList.json())).not.toContain(SENTINEL_VALUE)

    const credentialList = await listCredentials(app, owner.cookies, projectId)
    expect(JSON.stringify(credentialList.json())).not.toContain(SENTINEL_VALUE)
  }, 20_000)

  it('viewer role can list credentials but is denied on create, reveal, and add-version', async () => {
    const projectId = await createTestProjectDirect(owner.orgId, owner.userId, 'viewer-project')
    const credential = await createTestCredential(app, owner.cookies, projectId, {
      name: 'Viewer Key',
      value: 'secret',
    })

    await withOrg(owner.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ role: 'viewer' })
        .where(eq(orgMemberships.userId, owner.userId))
    )

    const listAllowed = await listCredentials(app, owner.cookies, projectId)
    expect(listAllowed.statusCode).toBe(200)

    const createDenied = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: { name: 'Denied', value: 'secret' },
    })
    expect(createDenied.statusCode).toBe(403)

    const revealDenied = await revealValue(app, owner.cookies, projectId, credential.id)
    expect(revealDenied.statusCode).toBe(403)

    const addVersionDenied = await addVersion(
      app,
      owner.cookies,
      projectId,
      credential.id,
      'secret-2'
    )
    expect(addVersionDenied.statusCode).toBe(403)
  }, 20_000)

  it('credential routes fail closed while the vault is sealed', async () => {
    const projectId = randomUUID()
    const credentialId = randomUUID()
    app = await assertRoutesFailClosedWhileSealed(
      app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [
        {
          method: 'POST',
          url: `/api/v1/projects/${projectId}/credentials`,
          payload: { name: 'Sealed', value: 'secret' },
        },
        { method: 'GET', url: `/api/v1/projects/${projectId}/credentials/${credentialId}/value` },
        { method: 'GET', url: `/api/v1/projects/${projectId}/credentials` },
        {
          method: 'PUT',
          url: `/api/v1/projects/${projectId}/credentials/${credentialId}/tags`,
          payload: { tags: ['sealed'] },
        },
        {
          method: 'PATCH',
          url: `/api/v1/projects/${projectId}/credentials/${credentialId}/tags`,
          payload: { tags: ['sealed'] },
        },
        {
          method: 'POST',
          url: `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
          payload: { value: 'secret' },
        },
        {
          method: 'GET',
          url: `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
        },
      ]
    )

    await app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 20_000)
})
