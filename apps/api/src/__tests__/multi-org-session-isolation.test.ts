import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentials, orgMemberships, projects, serviceEndpoints } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  mintOrgSessionCookies,
  registerAndLoginViaApi,
  createProjectViaApi,
} from './helpers/auth-test-helpers.js'
import { createUnsealedRouteSuite } from './helpers/unsealed-route-suite-test-helpers.js'

const { initVault } = await bootstrapRouteIntegrationTest()

const TEST_PASSPHRASE = 'multi-org-session-isolation-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const PROJECTS_URL = '/api/v1/projects'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

/**
 * Story 9.2 AC-23b/D7 point 3: multi-org membership was already reachable in production before
 * this story (project-invitation acceptance never checked for an existing membership elsewhere),
 * but apparently never regression-tested — this story's `POST /admin/orgs` deliberately makes it
 * a common, platform-operator-initiated path, so shipping it without closing this gap would
 * knowingly ship on top of an untested tenant-isolation assumption in a credential vault.
 */
describe.sequential('Story 9.2 AC-23b: multi-org user session scopes to only their JWT org', () => {
  suite.registerLifecycle()

  it('query-level: projects/credentials/service_endpoints RLS scoping holds for a user with active memberships in two orgs', async () => {
    const email = `multiorg-query-${randomUUID()}@example.com`
    const userA = await registerAndLoginViaApi(suite.app, {
      email,
      password: PASSWORD,
      orgName: `MultiOrg Query A ${randomUUID()}`,
    })
    const userB = await registerAndLoginViaApi(suite.app, {
      email: `multiorg-query-b-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `MultiOrg Query B ${randomUUID()}`,
    })
    // Grant userA's identity a second, active membership in orgB (mirrors D7 point 3's existing
    // reachable-today path — a project-invitation acceptance would do this implicitly).
    await withOrg(userB.orgId, (tx) =>
      tx.insert(orgMemberships).values({
        orgId: userB.orgId,
        userId: userA.userId,
        role: 'member',
        status: 'active',
      })
    )

    const [projectA] = await withOrg(userA.orgId, (tx) =>
      tx
        .insert(projects)
        .values({
          orgId: userA.orgId,
          name: 'Org A Project',
          slug: `org-a-project-${randomUUID().slice(0, 8)}`,
          createdBy: userA.userId,
        })
        .returning({ id: projects.id })
    )
    const [projectB] = await withOrg(userB.orgId, (tx) =>
      tx
        .insert(projects)
        .values({
          orgId: userB.orgId,
          name: 'Org B Project',
          slug: `org-b-project-${randomUUID().slice(0, 8)}`,
          createdBy: userB.userId,
        })
        .returning({ id: projects.id })
    )
    if (!projectA || !projectB) throw new Error('expected both test projects to be inserted')

    await withOrg(userA.orgId, (tx) =>
      tx.insert(credentials).values({
        orgId: userA.orgId,
        projectId: projectA.id,
        name: 'Org A Secret',
        createdBy: userA.userId,
      })
    )
    await withOrg(userB.orgId, (tx) =>
      tx.insert(credentials).values({
        orgId: userB.orgId,
        projectId: projectB.id,
        name: 'Org B Secret',
        createdBy: userB.userId,
      })
    )
    await withOrg(userA.orgId, (tx) =>
      tx.insert(serviceEndpoints).values({
        orgId: userA.orgId,
        projectId: projectA.id,
        name: 'Org A Endpoint',
        url: 'https://org-a.example.com',
      })
    )
    await withOrg(userB.orgId, (tx) =>
      tx.insert(serviceEndpoints).values({
        orgId: userB.orgId,
        projectId: projectB.id,
        name: 'Org B Endpoint',
        url: 'https://org-b.example.com',
      })
    )

    // RLS is the actual isolation mechanism — set_config('app.current_org_id', orgA) via
    // withOrg() must return ONLY orgA's rows, never orgB's, even though userA now holds an
    // active org_memberships row in both.
    const projectsInA = await withOrg(userA.orgId, (tx) => tx.select().from(projects))
    expect(projectsInA.map((p) => p.id)).toContain(projectA.id)
    expect(projectsInA.map((p) => p.id)).not.toContain(projectB.id)

    const credentialsInA = await withOrg(userA.orgId, (tx) => tx.select().from(credentials))
    expect(credentialsInA.every((c) => c.orgId === userA.orgId)).toBe(true)
    expect(credentialsInA.some((c) => c.orgId === userB.orgId)).toBe(false)

    const endpointsInA = await withOrg(userA.orgId, (tx) => tx.select().from(serviceEndpoints))
    expect(endpointsInA.every((e) => e.orgId === userA.orgId)).toBe(true)
    expect(endpointsInA.some((e) => e.orgId === userB.orgId)).toBe(false)

    // Sanity: querying with orgB context returns orgB's rows, not orgA's — proves the isolation
    // is genuinely bidirectional, not an artifact of orgA happening to run first.
    const projectsInB = await withOrg(userB.orgId, (tx) =>
      tx.select({ id: projects.id }).from(projects).where(eq(projects.orgId, userB.orgId))
    )
    expect(projectsInB.map((p) => p.id)).toContain(projectB.id)
    expect(projectsInB.map((p) => p.id)).not.toContain(projectA.id)
  })

  it('end-to-end: an org-A-scoped JWT for a multi-org user returns only org A projects via the API', async () => {
    const email = `multiorg-e2e-${randomUUID()}@example.com`
    const userA = await registerAndLoginViaApi(suite.app, {
      email,
      password: PASSWORD,
      orgName: `MultiOrg E2E A ${randomUUID()}`,
    })
    const userB = await registerAndLoginViaApi(suite.app, {
      email: `multiorg-e2e-b-${randomUUID()}@example.com`,
      password: PASSWORD,
      orgName: `MultiOrg E2E B ${randomUUID()}`,
    })
    // Story 4.5 D1/AC-V2: this test's last assertion (below) switches userA into an org-B
    // session and expects to see every org-B project. Role 'admin' (unconditional visibility
    // bypass) keeps that assertion focused on session/JWT-org scoping — this test's actual
    // subject — rather than incidentally also exercising the new per-project-membership
    // visibility gate, which is covered by its own dedicated tests elsewhere.
    await withOrg(userB.orgId, (tx) =>
      tx.insert(orgMemberships).values({
        orgId: userB.orgId,
        userId: userA.userId,
        role: 'admin',
        status: 'active',
      })
    )

    await createProjectViaApi(suite.app, userA.cookies, 'org-a-e2e-project')
    await createProjectViaApi(suite.app, userA.cookies, 'org-a-e2e-project-2')
    // 3 projects in org B, none visible to userA even though userA now has a valid org-B session.
    const orgBSessionCookies = await mintOrgSessionCookies(suite.app, userB.userId, userB.orgId)
    await createProjectViaApi(suite.app, orgBSessionCookies, 'org-b-e2e-project')
    await createProjectViaApi(suite.app, orgBSessionCookies, 'org-b-e2e-project-2')
    await createProjectViaApi(suite.app, orgBSessionCookies, 'org-b-e2e-project-3')

    const res = await suite.app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ data: { items: { orgId?: string }[] } }>()
    expect(body.data.items).toHaveLength(2)

    // A previously-issued org-A-scoped session, reused after userA gained an org-B membership,
    // continues to return only org A's data — the two sessions never bleed into each other.
    const resAgain = await suite.app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(userA.cookies) },
    })
    expect(resAgain.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(2)

    const orgBUserSessionForA = await mintOrgSessionCookies(suite.app, userA.userId, userB.orgId)
    const resSwitched = await suite.app.inject({
      method: 'GET',
      url: PROJECTS_URL,
      headers: { cookie: cookieHeader(orgBUserSessionForA) },
    })
    expect(resSwitched.statusCode).toBe(200)
    expect(resSwitched.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(3)
  })
})
