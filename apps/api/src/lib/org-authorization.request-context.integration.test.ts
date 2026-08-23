import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, organizations, sessions, users } from '@project-vault/db/schema'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  configureAuthIntegrationEnv,
  cookieHeader,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import type { CookieJar } from '../__tests__/helpers/auth-test-helpers.js'
import { checkOrgAuthorization } from './org-authorization.js'
import { getRequestContext } from './request-context.js'

configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

const TEST_PASSPHRASE = 'org-authz-request-context-tests-passphrase'
const TEST_ACCESS_TOKEN_TTL_SECONDS = 60 * 60
const GET = 'GET'
const CONCURRENCY_URL = '/api/v1/test/org-authz-rc-concurrency'

type JwtTestApp = Awaited<ReturnType<typeof createApp>> & {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string> | string
  }
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  route: (options: unknown) => unknown
}

function uniqueEmail(label: string): string {
  return `org-authz-rc-${label}-${randomUUID()}@example.com`
}

/** Mirrors secure-route.integration.test.ts's createAuthenticatedSession helper — mints a real
 * org/user/owner-membership/session and a valid access-token cookie, without going through the
 * register/login HTTP routes (keeps this file focused on ambient-context behavior). */
async function createAuthenticatedSession(
  app: Awaited<ReturnType<typeof createApp>>,
  label: string
): Promise<{ userId: string; orgId: string; cookies: CookieJar }> {
  const orgName = `OrgAuthzRC ${label} ${randomUUID()}`
  const [org] = await getDb()
    .insert(organizations)
    .values({ name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
    .returning({ id: organizations.id })
  if (!org) throw new Error('createAuthenticatedSession: org insert returned no row')

  const [user] = await getDb()
    .insert(users)
    .values({ email: uniqueEmail(label), passwordHash: 'test-password-hash' })
    .returning({ id: users.id })
  if (!user) throw new Error('createAuthenticatedSession: user insert returned no row')

  const jti = randomUUID()
  await withOrg(org.id, async (tx) => {
    await tx
      .insert(orgMemberships)
      .values({ orgId: org.id, userId: user.id, role: 'owner', status: 'active' })
    await tx.insert(sessions).values({
      userId: user.id,
      orgId: org.id,
      jti,
      sessionVersion: 1,
      expiresAt: new Date(Date.now() + TEST_ACCESS_TOKEN_TTL_SECONDS * 1000),
    })
  })

  const accessToken = await (app as JwtTestApp).jwt.sign(
    { sub: user.id, orgId: org.id, sessionVersion: 1 },
    { jti, expiresIn: TEST_ACCESS_TOKEN_TTL_SECONDS }
  )
  return { userId: user.id, orgId: org.id, cookies: { 'access-token': accessToken } }
}

describe.sequential(
  'checkOrgAuthorization — Story 23.11 ambient-context AC7/AC8/AC9 (live Postgres, real request lifecycle)',
  () => {
    beforeAll(async () => {
      await resetVaultForTest()
      await initVaultForTest(initVault, TEST_PASSPHRASE)
    })

    afterAll(async () => {
      await resetVaultForTest()
    })

    it('AC7: a viewerIdentityId that is a real member of a DIFFERENT org (not the ambient one) is denied/not-a-member, never authorized', async () => {
      const app = await createApp({ logger: false })
      ;(app as JwtTestApp).route({
        method: GET,
        url: '/api/v1/test/org-authz-rc-cross-org',
        preHandler: [(app as JwtTestApp).authenticate],
        handler: async (request: FastifyRequest) => {
          const viewerIdentityId = (request.query as { viewerIdentityId: string }).viewerIdentityId
          const outcome = await checkOrgAuthorization(
            { viewerIdentityId, minimumRole: 'viewer' },
            { extensionName: 'test-extension' }
          )
          return { data: { ambientOrgId: getRequestContext()?.orgId, outcome } }
        },
      })

      const orgA = await createAuthenticatedSession(app, 'org-a')
      const orgB = await createAuthenticatedSession(app, 'org-b')

      // orgB.userId is a real, active owner of org B — but the ambient context bound for this
      // request is org A's (the requester is logged into org A). The whole point of AC7 is that
      // checkOrgAuthorization can no longer be steered to check membership in an arbitrary org —
      // it always resolves against the ambient org, here org A, where orgB.userId has no row.
      const res = await app.inject({
        method: GET,
        url: `/api/v1/test/org-authz-rc-cross-org?viewerIdentityId=${orgB.userId}`,
        headers: { cookie: cookieHeader(orgA.cookies) },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        data: {
          ambientOrgId: orgA.orgId,
          outcome: { outcome: 'denied', reasonCode: 'not-a-member' },
        },
      })

      await app.close()
    }, 20_000)

    it("AC8: two concurrent, interleaved requests for different orgs never see each other's ambient context", async () => {
      const app = await createApp({ logger: false })
      ;(app as JwtTestApp).route({
        method: GET,
        url: CONCURRENCY_URL,
        preHandler: [(app as JwtTestApp).authenticate],
        handler: async (request: FastifyRequest) => {
          const before = getRequestContext()
          // Force a real interleaving point: yield to the event loop with a small, randomized
          // delay so two in-flight requests' async continuations genuinely interleave, not just
          // resolve back-to-back in issue order.
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 15))
          const auth = (request as FastifyRequest & { authContext?: { userId: string } })
            .authContext
          const outcome = await checkOrgAuthorization(
            { viewerIdentityId: auth?.userId ?? '', minimumRole: 'viewer' },
            { extensionName: 'test-extension' }
          )
          const after = getRequestContext()
          return { data: { before, after, outcome } }
        },
      })

      const orgA = await createAuthenticatedSession(app, 'concurrency-a')
      const orgB = await createAuthenticatedSession(app, 'concurrency-b')

      const iterations = 8
      const requests = Array.from({ length: iterations }, (_, index) =>
        index % 2 === 0
          ? app.inject({
              method: GET,
              url: CONCURRENCY_URL,
              headers: { cookie: cookieHeader(orgA.cookies) },
            })
          : app.inject({
              method: GET,
              url: CONCURRENCY_URL,
              headers: { cookie: cookieHeader(orgB.cookies) },
            })
      )

      const responses = await Promise.all(requests)

      responses.forEach((res, index) => {
        expect(res.statusCode).toBe(200)
        const body = res.json<{
          data: {
            before: { orgId: string; userId: string }
            after: { orgId: string; userId: string }
            outcome: { outcome: string }
          }
        }>()
        const expectedOrg = index % 2 === 0 ? orgA : orgB
        // Ambient context read BEFORE and AFTER the interleaving await both resolve to this
        // request's own org/user — never the other concurrently-running request's.
        expect(body.data.before).toEqual({ orgId: expectedOrg.orgId, userId: expectedOrg.userId })
        expect(body.data.after).toEqual({ orgId: expectedOrg.orgId, userId: expectedOrg.userId })
        // Each request's own session is an active owner of its own org, so checkOrgAuthorization
        // (resolved against the ambient org) is authorized — never leaking into the other org.
        expect(body.data.outcome).toEqual({ outcome: 'authorized' })
      })

      await app.close()
    }, 20_000)

    it('AC9: the ambient context is bound inside the authenticate preHandler itself — unbound before it runs, bound immediately after, before any later preHandler stage or the route handler', async () => {
      const app = await createApp({ logger: false })
      const observed: { beforeAuthenticate?: unknown; afterAuthenticate?: unknown } = {}

      ;(app as JwtTestApp).route({
        method: GET,
        url: '/api/v1/test/org-authz-rc-bind-timing',
        // A hand-built preHandler chain (not secureRoute's fixed chain) so a stage can run BEFORE
        // fastify.authenticate and another stage immediately AFTER it, proving the bind happens
        // inside authenticate's own preHandler function — not a later hook stage an
        // extension-adjacent plugin could theoretically run between (Red Team / AC9 finding).
        preHandler: [
          (_request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
            observed.beforeAuthenticate = getRequestContext()
            done()
          },
          (app as JwtTestApp).authenticate,
          (_request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
            observed.afterAuthenticate = getRequestContext()
            done()
          },
        ],
        handler: async (request: FastifyRequest) => {
          const auth = (
            request as FastifyRequest & { authContext?: { orgId: string; userId: string } }
          ).authContext
          return {
            data: {
              handlerContext: getRequestContext(),
              authContext: auth ? { orgId: auth.orgId, userId: auth.userId } : undefined,
            },
          }
        },
      })

      const session = await createAuthenticatedSession(app, 'bind-timing')

      const res = await app.inject({
        method: GET,
        url: '/api/v1/test/org-authz-rc-bind-timing',
        headers: { cookie: cookieHeader(session.cookies) },
      })

      expect(res.statusCode).toBe(200)
      // Unbound before authenticate's preHandler ever runs.
      expect(observed.beforeAuthenticate).toBeUndefined()
      // Bound to exactly the same values authenticateRequest() placed on request.authContext,
      // strictly after authenticate's preHandler returns — i.e. inside it, before any later stage.
      expect(observed.afterAuthenticate).toEqual({ orgId: session.orgId, userId: session.userId })
      const body = res.json<{
        data: {
          handlerContext: { orgId: string; userId: string }
          authContext: { orgId: string; userId: string }
        }
      }>()
      expect(body.data.handlerContext).toEqual({ orgId: session.orgId, userId: session.userId })
      expect(body.data.handlerContext).toEqual(body.data.authContext)

      await app.close()
    }, 20_000)
  }
)
