import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, projects, userIdentityTokens } from '@project-vault/db/schema'
import {
  assertRoutesFailClosedWhileSealed,
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { createDirectAuthenticatedUser } from '../../__tests__/helpers/org-role-test-helpers.js'
import {
  createCredentialTestProject,
  createCredentialViaApi,
  SENTINEL_VALUE,
} from '../credentials/credential-route-test-helpers.js'
import { expectSearchResults } from './search-route-test-helpers.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>
type RegisteredUser = Awaited<ReturnType<typeof createDirectAuthenticatedUser>>

const TEST_PASSPHRASE = 'search-routes-passphrase'
const SEARCH_URL = '/api/v1/search'
const PROJECTS_URL = '/api/v1/projects'
const CREDENTIAL_SEARCH_EVENT = 'credential.search'
const GITHUB_NAME = 'github'

async function registerUser(app: TestApp, label: string): Promise<RegisteredUser> {
  return createDirectAuthenticatedUser(app, label, 'member', 'search-test')
}

async function search(
  app: TestApp,
  cookies: Record<string, string>,
  query = ''
): Promise<{ statusCode: number; json<T>(): T }> {
  const url = query ? `${SEARCH_URL}?${query}` : SEARCH_URL
  return app.inject({
    method: 'GET',
    url,
    headers: { cookie: cookieHeader(cookies) },
  })
}

describe.sequential('search routes', () => {
  const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)
  suite.registerLifecycle()

  it('should return credential results matching query by name', async () => {
    const user = await registerUser(suite.app, 'cred-name')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'payments')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Stripe API Key',
      value: SENTINEL_VALUE,
    })

    const res = await search(suite.app, user.cookies, 'q=stripe')
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { results: { type: string; name: string }[]; total: number } }>()
    expect(body.data.total).toBeGreaterThan(0)
    expectSearchResults(res, (results) =>
      results.some((r) => r.type === 'credential' && r.name === 'Stripe API Key')
    )
  }, 20_000)

  it('should return project results matching query by name', async () => {
    const user = await registerUser(suite.app, 'project-name')
    await suite.app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'stripe-integrations', slug: `stripe-${randomUUID().slice(0, 8)}` },
    })

    const res = await search(suite.app, user.cookies, 'q=stripe')
    expectSearchResults(res, (results) =>
      results.some((r) => r.type === 'project' && r.name === 'stripe-integrations')
    )
  }, 20_000)

  it('should return results from both types when types param is omitted', async () => {
    const user = await registerUser(suite.app, 'both-types')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'both')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Stripe Shared',
      value: 'x',
    })
    await suite.app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Stripe Hub', slug: `hub-${randomUUID().slice(0, 8)}` },
    })

    const res = await search(suite.app, user.cookies, 'q=stripe')
    const body = res.json<{ data: { results: { type: string }[] } }>()
    const types = new Set(body.data.results.map((r) => r.type))
    expect(types.has('credential')).toBe(true)
    expect(types.has('project')).toBe(true)
  }, 20_000)

  it('should filter to credentials only when types=credentials', async () => {
    const user = await registerUser(suite.app, 'types-cred')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'types-cred')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Stripe Only',
      value: 'x',
    })
    await suite.app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Stripe Project', slug: `sp-${randomUUID().slice(0, 8)}` },
    })

    const res = await search(suite.app, user.cookies, 'q=stripe&types=credentials')
    const body = res.json<{ data: { results: { type: string }[] } }>()
    expect(body.data.results.every((r) => r.type === 'credential')).toBe(true)
  }, 20_000)

  it('should filter to projects only when types=projects', async () => {
    const user = await registerUser(suite.app, 'types-project')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'types-project')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Stripe Hidden',
      value: 'x',
    })

    const res = await search(suite.app, user.cookies, 'q=stripe&types=projects')
    const body = res.json<{ data: { results: { type: string }[] } }>()
    expect(body.data.results.every((r) => r.type === 'project')).toBe(true)
    expect(body.data.results.some((r) => r.type === 'credential')).toBe(false)
  }, 20_000)

  it('should apply default limit of 20 when limit param is omitted', async () => {
    const user = await registerUser(suite.app, 'default-limit')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'limit-default')
    for (let i = 0; i < 25; i++) {
      await createCredentialViaApi(suite.app, user.cookies, projectId, {
        name: `api-key-${i}`,
        value: 'secret',
      })
    }

    const res = await search(suite.app, user.cookies, 'q=api-key')
    const body = res.json<{ data: { results: unknown[] } }>()
    expect(body.data.results.length).toBe(20)
  }, 60_000)

  it('should respect limit param up to max of 50', async () => {
    const user = await registerUser(suite.app, 'limit-50')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'limit-50')
    for (let i = 0; i < 15; i++) {
      await createCredentialViaApi(suite.app, user.cookies, projectId, {
        name: `limit-key-${i}`,
        value: 'secret',
      })
    }

    const res = await search(suite.app, user.cookies, 'q=limit-key&limit=10')
    expect(res.json<{ data: { results: unknown[] } }>().data.results.length).toBe(10)
  }, 40_000)

  it('should return 400 when limit exceeds 50', async () => {
    const user = await registerUser(suite.app, 'limit-51')
    const res = await search(suite.app, user.cookies, 'q=test&limit=51')
    expect(res.statusCode).toBe(422)
  })

  it('should return 400 when q is empty string', async () => {
    const user = await registerUser(suite.app, 'empty-q')
    const res = await search(suite.app, user.cookies, 'q=')
    expect(res.statusCode).toBe(422)
  })

  // Story 9.3 D8.3/AC-11: page/limit/hasNext siblings of results/total, matching every other
  // collection endpoint — previously entirely absent from SearchResponseSchema.
  it('includes page/limit/hasNext pagination fields in the response (AC-11)', async () => {
    const user = await registerUser(suite.app, 'pagination-fields')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'pg-fields')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'pagination-fields-key',
      value: 'secret',
    })

    const res = await search(suite.app, user.cookies, 'q=pagination-fields-key')
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      data: { results: unknown[]; total: number; page: number; limit: number; hasNext: boolean }
    }>()
    expect(body.data).toMatchObject({ page: 1, limit: 20, hasNext: false })
  })

  it('paginates across the result set using the page param (AC-11/D8.3)', async () => {
    const user = await registerUser(suite.app, 'pagination-page')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'pg-page')
    for (let i = 0; i < 5; i++) {
      await createCredentialViaApi(suite.app, user.cookies, projectId, {
        name: `pg-page-key-${i}`,
        value: 'secret',
      })
    }

    const firstPage = await search(suite.app, user.cookies, 'q=pg-page-key&limit=2&page=1')
    const firstBody = firstPage.json<{
      data: { results: unknown[]; total: number; page: number; limit: number; hasNext: boolean }
    }>()
    expect(firstBody.data.results).toHaveLength(2)
    expect(firstBody.data).toMatchObject({ total: 5, page: 1, limit: 2, hasNext: true })

    const lastPage = await search(suite.app, user.cookies, 'q=pg-page-key&limit=2&page=3')
    const lastBody = lastPage.json<{
      data: { results: unknown[]; total: number; page: number; limit: number; hasNext: boolean }
    }>()
    expect(lastBody.data.results).toHaveLength(1)
    expect(lastBody.data).toMatchObject({ total: 5, page: 3, limit: 2, hasNext: false })

    // Beyond available data: a well-formed empty page, not an error.
    const beyond = await search(suite.app, user.cookies, 'q=pg-page-key&limit=2&page=99')
    const beyondBody = beyond.json<{
      data: { results: unknown[]; total: number; hasNext: boolean }
    }>()
    expect(beyondBody.data.results).toEqual([])
    expect(beyondBody.data).toMatchObject({ total: 5, hasNext: false })
  }, 30_000)

  it('rejects a non-positive page param', async () => {
    const user = await registerUser(suite.app, 'page-invalid')
    const res = await search(suite.app, user.cookies, 'q=test&page=0')
    expect(res.statusCode).toBe(422)
  })

  it('rejects an overlong page param that would overflow to Infinity (regression, edge-case review)', async () => {
    // Number.parseInt('9'.repeat(400), 10) === Infinity, which is >= 1 and previously slipped
    // past validation — would have flowed into (page - 1) * limit as Infinity and failed at the
    // database layer instead of returning a clean 422.
    const user = await registerUser(suite.app, 'page-overflow')
    const res = await search(suite.app, user.cookies, `q=test&page=${'9'.repeat(400)}`)
    expect(res.statusCode).toBe(422)
  })

  it('should rank exact name match above prefix match above substring match', async () => {
    const user = await registerUser(suite.app, 'ranking')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'rank')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: GITHUB_NAME,
      value: 'a',
    })
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: `${GITHUB_NAME}-actions-key`,
      value: 'b',
    })
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'other',
      value: 'c',
      description: 'mentions github in description',
    })

    const res = await search(suite.app, user.cookies, `q=${GITHUB_NAME}`)
    const names = res
      .json<{ data: { results: { type: string; name: string }[] } }>()
      .data.results.filter((r) => r.type === 'credential')
      .map((r) => r.name)
    expect(names.indexOf(GITHUB_NAME)).toBeLessThan(names.indexOf(`${GITHUB_NAME}-actions-key`))
    expect(names.indexOf(`${GITHUB_NAME}-actions-key`)).toBeLessThan(names.indexOf('other'))
  }, 30_000)

  it('should rank more recently updated results first within same tier', async () => {
    const user = await registerUser(suite.app, 'updated-order')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'updated')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'shared-tier-a',
      value: '1',
    })
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'shared-tier-b',
      value: '2',
    })

    const res = await search(suite.app, user.cookies, 'q=shared-tier')
    const names = res
      .json<{ data: { results: { name: string }[] } }>()
      .data.results.map((r) => r.name)
    expect(names[0]).toBe('shared-tier-b')
  }, 20_000)

  it('should return zero results when searching a known credential value (AC-E2a blocker)', async () => {
    const user = await registerUser(suite.app, 'value-blocker')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'blocker')
    const secret = 'sk_live_SENSITIVE_VALUE_12345'
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'PaymentProcessor Key',
      value: secret,
    })

    const res = await search(suite.app, user.cookies, `q=${encodeURIComponent(secret)}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { results: unknown[]; total: number } }>().data).toEqual({
      results: [],
      total: 0,
      query: secret,
      types: ['credentials', 'projects'],
      page: 1,
      limit: 20,
      hasNext: false,
    })
  }, 20_000)

  it('should return zero results for a user from Org B when searching Org A credentials', async () => {
    const orgA = await registerUser(suite.app, 'org-a')
    const orgB = await createDirectAuthenticatedUser(suite.app, 'org-b-search')
    const projectId = await createCredentialTestProject(suite.app, orgA.cookies, 'org-a-only')
    await createCredentialViaApi(suite.app, orgA.cookies, projectId, {
      name: 'Org A Stripe Key',
      value: 'x',
    })

    const res = await search(suite.app, orgB.cookies, 'q=stripe')
    const names = res
      .json<{ data: { results: { name: string }[] } }>()
      .data.results.map((r) => r.name)
    expect(names).not.toContain('Org A Stripe Key')
  }, 30_000)

  it('should return zero results from Org B when searching by a tag that only exists in Org B', async () => {
    const orgA = await registerUser(suite.app, 'tag-a')
    const orgB = await createDirectAuthenticatedUser(suite.app, 'tag-b')
    const projectA = await createCredentialTestProject(suite.app, orgA.cookies, 'tag-a')
    await createCredentialViaApi(suite.app, orgA.cookies, projectA, {
      name: 'Key A',
      value: 'x',
      tags: ['org-a-only-tag'],
    })
    const projectB = await createCredentialTestProject(suite.app, orgB.cookies, 'tag-b')
    await createCredentialViaApi(suite.app, orgB.cookies, projectB, {
      name: 'Key B',
      value: 'x',
      tags: ['org-b-only-tag'],
    })

    const res = await search(suite.app, orgA.cookies, 'q=org-b-only-tag')
    expect(res.json<{ data: { total: number } }>().data.total).toBe(0)
  }, 30_000)

  it('should return 401 for unauthenticated requests', async () => {
    const res = await suite.app.inject({ method: 'GET', url: `${SEARCH_URL}?q=test` })
    expect(res.statusCode).toBe(401)
  })

  it('should return 503 when vault is sealed', async () => {
    suite.app = await assertRoutesFailClosedWhileSealed(
      suite.app,
      () => createApp({ logger: false, vaultGuardEnabled: true }),
      [{ method: 'GET', url: `${SEARCH_URL}?q=test` }]
    )

    await suite.app.close()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    suite.app = await createApp({ logger: false, vaultGuardEnabled: true })
  }, 30_000)

  it('should write a credential.search audit entry when credential results are returned', async () => {
    const user = await registerUser(suite.app, 'audit-write')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'audit')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Audit Stripe',
      value: 'x',
    })

    await search(suite.app, user.cookies, 'q=stripe&types=credentials')

    const rows = await withOrg(user.orgId, (tx) =>
      tx
        .select({ eventType: auditLogEntries.eventType })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SEARCH_EVENT))
    )
    expect(rows.length).toBeGreaterThan(0)
  }, 20_000)

  it('should store actorTokenId (not raw userId) in audit entry', async () => {
    const user = await registerAndLoginViaApi(suite.app, {
      email: `search-audit-actor-${randomUUID()}@example.com`,
      password: 'correct-horse-battery-staple',
      orgName: `Search Audit Actor ${randomUUID()}`,
    })
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'audit-actor')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Actor Stripe',
      value: 'x',
    })
    await search(suite.app, user.cookies, 'q=actor&types=credentials')

    const tokens = await withOrg(user.orgId, (tx) =>
      tx
        .select({ id: userIdentityTokens.id })
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.userId, user.userId))
    )
    const audit = await withOrg(user.orgId, (tx) =>
      tx
        .select({ actorTokenId: auditLogEntries.actorTokenId })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SEARCH_EVENT))
        .limit(1)
    )
    expect(audit[0]?.actorTokenId).not.toBe(user.userId)
    expect(tokens.some((t) => t.id === audit[0]?.actorTokenId)).toBe(true)
  }, 20_000)

  it('should NOT write audit entry when only project results are returned', async () => {
    const user = await registerUser(suite.app, 'audit-project-only')
    await suite.app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Only Project Stripe', slug: `only-${randomUUID().slice(0, 8)}` },
    })

    const before = await withOrg(user.orgId, (tx) =>
      tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SEARCH_EVENT))
    )
    await search(suite.app, user.cookies, 'q=only&types=projects')
    const after = await withOrg(user.orgId, (tx) =>
      tx
        .select({ id: auditLogEntries.id })
        .from(auditLogEntries)
        .where(eq(auditLogEntries.eventType, CREDENTIAL_SEARCH_EVENT))
    )
    expect(after.length).toBe(before.length)
  }, 20_000)

  it('should return credentials matching a tag substring', async () => {
    const user = await registerUser(suite.app, 'tag-cred')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'tag-cred')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Tagged Key',
      value: 'x',
      tags: ['payments-prod'],
    })

    const res = await search(suite.app, user.cookies, 'q=payments-prod&types=credentials')
    expect(
      res
        .json<{ data: { results: { name: string }[] } }>()
        .data.results.some((r) => r.name === 'Tagged Key')
    ).toBe(true)
  }, 20_000)

  it('should return projects matching a tag substring', async () => {
    const user = await registerUser(suite.app, 'tag-project')
    const slug = `tagged-${randomUUID().slice(0, 8)}`
    const created = await suite.app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Tagged Project', slug },
    })
    const projectId = created.json<{ data: { id: string } }>().data.id
    await suite.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${projectId}/tags`,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { tags: ['infra-core'] },
    })

    const res = await search(suite.app, user.cookies, 'q=infra-core&types=projects')
    expect(
      res
        .json<{ data: { results: { name: string }[] } }>()
        .data.results.some((r) => r.name === 'Tagged Project')
    ).toBe(true)
  }, 20_000)

  it('should return empty results when no credentials or projects match', async () => {
    const user = await registerUser(suite.app, 'empty')
    const res = await search(suite.app, user.cookies, 'q=zzznomatch')
    expect(res.json<{ data: { total: number } }>().data.total).toBe(0)
  })

  it('should handle special characters in query without SQL error', async () => {
    const user = await registerUser(suite.app, 'special')
    const res = await search(suite.app, user.cookies, `q=${encodeURIComponent('%_%\\')}`)
    expect(res.statusCode).toBe(200)
  })

  it('should handle Unicode and emoji characters in query without SQL error', async () => {
    const user = await registerUser(suite.app, 'unicode')
    const res = await search(suite.app, user.cookies, `q=${encodeURIComponent('日本語🔑')}`)
    expect(res.statusCode).toBe(200)
  })

  it('should handle SQL injection attempt in q parameter without leaking data', async () => {
    const user = await registerUser(suite.app, 'injection')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'inject')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Safe Key',
      value: 'x',
    })
    const res = await search(suite.app, user.cookies, `q=${encodeURIComponent("' OR 1=1 --")}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ data: { total: number } }>().data.total).toBe(0)
  }, 20_000)

  it('should handle very long query (200 chars) without error', async () => {
    const user = await registerUser(suite.app, 'long-q')
    const q = 'a'.repeat(200)
    const res = await search(suite.app, user.cookies, `q=${q}`)
    expect(res.statusCode).toBe(200)
  })

  it('should return 400 when query exceeds 200 chars', async () => {
    const user = await registerUser(suite.app, 'too-long')
    const res = await search(suite.app, user.cookies, `q=${'a'.repeat(201)}`)
    expect(res.statusCode).toBe(422)
  })

  it('should return 400 when limit is a non-integer string (e.g. "10abc")', async () => {
    const user = await registerUser(suite.app, 'bad-limit')
    const res = await search(suite.app, user.cookies, 'q=test&limit=10abc')
    expect(res.statusCode).toBe(422)
  })

  it('should not return archived projects in search results', async () => {
    const user = await registerUser(suite.app, 'archived-project')
    const create = await suite.app.inject({
      method: 'POST',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(user.cookies) },
      payload: { name: 'Archived Stripe Hub', slug: `arch-${randomUUID().slice(0, 8)}` },
    })
    const projectId = create.json<{ data: { id: string } }>().data.id
    await withOrg(user.orgId, (tx) =>
      tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))
    )

    const res = await search(suite.app, user.cookies, 'q=Archived Stripe')
    expect(
      res
        .json<{ data: { results: { name: string }[] } }>()
        .data.results.some((r) => r.name === 'Archived Stripe Hub')
    ).toBe(false)
  }, 20_000)

  it('should not return credentials from archived projects in search results', async () => {
    const user = await registerUser(suite.app, 'archived-cred')
    const projectId = await createCredentialTestProject(suite.app, user.cookies, 'arch-cred')
    await createCredentialViaApi(suite.app, user.cookies, projectId, {
      name: 'Archived Project Stripe Key',
      value: 'x',
    })
    await withOrg(user.orgId, (tx) =>
      tx.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId))
    )

    const res = await search(suite.app, user.cookies, 'q=Archived Project Stripe')
    expect(res.json<{ data: { total: number } }>().data.total).toBe(0)
  }, 20_000)

  it('returns 400 for invalid search types', async () => {
    const user = await registerUser(suite.app, 'invalid-type')
    const res = await search(suite.app, user.cookies, 'q=test&types=invalid')
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('invalid_search_type')
  })
})
