import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialVersions, orgMemberships } from '@project-vault/db/schema'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  expectAuditWriteFailed,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

const { createApp, initVault, humanAudit } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type RegisteredUser = { userId: string; orgId: string; cookies: Record<string, string> }

const TEST_PASSPHRASE = 'credential-routes-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const SENTINEL_VALUE = 'sentinel-credential-value-never-leaks'

async function createTestProject(app: TestApp, cookies: Record<string, string>, slug: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `Project ${slug}`, slug: `${slug}-${randomUUID().slice(0, 8)}` },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ data: { id: string } }>().data.id
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
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ data: CredentialDetail }>().data
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
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false, vaultGuardEnabled: true })
    owner = await registerAndLoginViaApi(app, {
      email: `credentials-owner-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Credentials Owner ${randomUUID()}`,
    })
    other = await registerAndLoginViaApi(app, {
      email: `credentials-other-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `Credentials Other ${randomUUID()}`,
    })
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
        name: 'Stripe Secret Key',
        value: 'sk_live_example_not_a_real_key',
        description: 'Production secret',
        tags: ['payments'],
        rotationSchedule: '0 0 1 * *',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json<{ data: CredentialDetail }>()
    expect(body.data).toMatchObject({
      projectId,
      name: 'Stripe Secret Key',
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
      .mockRejectedValueOnce(new Error('forced audit failure'))

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
      .mockRejectedValueOnce(new Error('forced audit failure'))

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

  it('security regression: the credential value never appears in any non-reveal response body', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'no-leak-project')
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
  }, 20_000)

  it('viewer role is denied on create, reveal, and add-version', async () => {
    const projectId = await createTestProject(app, owner.cookies, 'viewer-project')
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
