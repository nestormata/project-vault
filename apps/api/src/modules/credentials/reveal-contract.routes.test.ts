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
import {
  bootCredentialRouteApp,
  createCredentialTestProject,
  createCredentialViaApi,
  SENTINEL_VALUE,
} from './credential-route-test-helpers.js'

// Story 72.8 (P11 reveal contract, P6 audit verbs): what the server records for a reveal and a new
// version, and that a denied reveal tells a caller nothing about whether the credential exists.

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'reveal-contract',
  orgNamePrefix: 'RevealContract',
})

const REVEALED = 'credential.value_revealed'
const ORIGINAL_BYPASS = process.env['RATE_LIMIT_TEST_BYPASS']

function revealUrl(projectId: string, credentialId: string, query = ''): string {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/value${query}`
}

function reveal(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  query = ''
) {
  return app.inject({
    method: 'GET',
    url: revealUrl(projectId, credentialId, query),
    headers: { cookie: cookieHeader(cookies) },
  })
}

async function auditRows(orgId: string, eventType: string, resourceId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({ payload: auditLogEntries.payload, revealedFields: auditLogEntries.revealedFields })
      .from(auditLogEntries)
      .where(
        and(eq(auditLogEntries.eventType, eventType), eq(auditLogEntries.resourceId, resourceId))
      )
      .orderBy(desc(auditLogEntries.createdAt))
  )
}

describe('reveal contract and audit verbs (72-8)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootCredentialRouteApp(createApp, initVault, 'reveal-contract-passphrase')
  })

  afterEach(() => {
    if (ORIGINAL_BYPASS === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
    else process.env['RATE_LIMIT_TEST_BYPASS'] = ORIGINAL_BYPASS
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('marks a copy reveal with purpose copy, and leaves a view reveal without a purpose', async () => {
    const owner = await registerOwner(app, 'purpose-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'reveal-purpose')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Purpose Key',
      value: SENTINEL_VALUE,
    })

    const view = await reveal(app, owner.cookies, projectId, credential.id)
    const explicitView = await reveal(app, owner.cookies, projectId, credential.id, '?purpose=view')
    const copy = await reveal(app, owner.cookies, projectId, credential.id, '?purpose=copy')
    expect([view.statusCode, explicitView.statusCode, copy.statusCode]).toEqual([200, 200, 200])

    const rows = await auditRows(owner.orgId, REVEALED, credential.id)
    const purposes = rows.map((row) => (row.payload as { purpose?: string }).purpose)
    expect(purposes.filter((purpose) => purpose === 'copy')).toHaveLength(1)
    expect(purposes.filter((purpose) => purpose === undefined)).toHaveLength(2)
    // The value never reaches the audit payload.
    expect(JSON.stringify(rows)).not.toContain(SENTINEL_VALUE)
  }, 60_000)

  it('rejects an unknown purpose with 422 and writes no audit row', async () => {
    const owner = await registerOwner(app, 'purpose-bad-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'reveal-purpose-bad')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Purpose Bad Key',
      value: SENTINEL_VALUE,
    })
    const before = (await auditRows(owner.orgId, REVEALED, credential.id)).length
    const res = await reveal(app, owner.cookies, projectId, credential.id, '?purpose=totp')
    expect(res.statusCode).toBe(422)
    expect(res.body).not.toContain(SENTINEL_VALUE)
    const after = (await auditRows(owner.orgId, REVEALED, credential.id)).length
    expect(after).toBe(before)
  }, 60_000)

  it('names changed, added and removed field keys on credential.version_created, never a value', async () => {
    const owner = await registerOwner(app, 'fields-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'version-fields')
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        name: 'Field Delta Key',
        fields: [
          { key: 'username', value: 'alice', sensitive: false },
          { key: 'password', value: 'first-secret-value', sensitive: true },
          { key: 'region', value: 'eu', sensitive: false },
        ],
      },
    })
    expect(created.statusCode).toBe(201)
    const credentialId = created.json<{ data: { id: string } }>().data.id

    const next = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
      headers: { cookie: cookieHeader(owner.cookies) },
      payload: {
        fields: [
          { key: 'username', value: 'alice', sensitive: false },
          { key: 'password', value: 'second-secret-value', sensitive: true },
          { key: 'token', value: 'brand-new-token', sensitive: true },
          { key: 'note', value: 'plain-note', sensitive: false },
        ],
      },
    })
    expect(next.statusCode).toBe(201)

    const rows = await auditRows(owner.orgId, 'credential.version_created', credentialId)
    const payload = rows.find(
      (row) => (row.payload as { versionNumber?: number }).versionNumber === 2
    )?.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      versionNumber: 2,
      addedFields: ['token', 'note'],
      removedFields: ['region'],
      renamedFields: [],
      changedFields: ['password'],
    })
    const serialized = JSON.stringify(rows)
    for (const secret of ['first-secret-value', 'second-secret-value', 'brand-new-token']) {
      expect(serialized).not.toContain(secret)
    }
  }, 60_000)

  it('gives a project-role viewer, a non-member and a missing credential no more than today', async () => {
    const owner = await registerOwner(app, 'oracle-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'reveal-oracle')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Oracle Key',
      value: SENTINEL_VALUE,
    })
    const outsider = await addUserToOrg(app, owner.orgId, 'oracle-outsider', { orgRole: 'member' })

    const unknownCredential = await reveal(app, outsider.cookies, projectId, randomUUID())
    const existingCredential = await reveal(app, outsider.cookies, projectId, credential.id)
    const existingCopy = await reveal(
      app,
      outsider.cookies,
      projectId,
      credential.id,
      '?purpose=copy'
    )
    const unknownProject = await reveal(app, outsider.cookies, randomUUID(), credential.id)

    // A caller who cannot see the project cannot tell a real credential from an invented one, nor a
    // real project from an invented one, and the purpose parameter changes nothing.
    for (const denied of [existingCredential, existingCopy, unknownProject]) {
      expect(denied.statusCode).toBe(unknownCredential.statusCode)
      expect(denied.json()).toEqual(unknownCredential.json())
    }
    expect(unknownCredential.statusCode).toBe(404)
    expect(JSON.stringify([unknownCredential.json()])).not.toContain(SENTINEL_VALUE)

    const rows = await auditRows(owner.orgId, REVEALED, credential.id)
    expect(rows).toHaveLength(0)
  }, 60_000)

  it('rate-limits reveal per user: one caller hitting the limit does not affect another', async () => {
    const owner = await registerOwner(app, 'ratelimit-owner')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'reveal-ratelimit')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Rate Key',
      value: SENTINEL_VALUE,
    })
    const viewer = await addUserToOrg(app, owner.orgId, 'ratelimit-viewer', { orgRole: 'member' })
    await addProjectMember(owner.orgId, projectId, viewer.userId, 'viewer')

    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    // The project-role denial happens in the handler, after the rate limiter, so each attempt
    // spends the viewer's bucket without decrypting anything or writing an audit row.
    const statuses: number[] = []
    for (let attempt = 0; attempt < 121; attempt += 1) {
      const res = await reveal(app, viewer.cookies, projectId, credential.id)
      statuses.push(res.statusCode)
    }
    expect(statuses.slice(0, 120).every((status) => status === 403)).toBe(true)
    expect(statuses[120]).toBe(429)

    const ownerReveal = await reveal(app, owner.cookies, projectId, credential.id)
    expect(ownerReveal.statusCode).toBe(200)
  }, 120_000)
})
