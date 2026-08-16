import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lt, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import {
  bootUnsealedRouteApp,
  bootstrapRouteIntegrationTest,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  __resetNativeLoginPolicyForTests,
  markReplacementProven,
  resolveNativeLoginPolicy,
} from './native-login-policy.js'
import type { ExtensionState } from '../../extensions/loader.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
// This suite reuses one shared app across many gate assertions on the same rate-limited routes
// (mfa/recover, recovery/request) — not testing rate limiting itself, so bypass it explicitly
// (see route-helpers.ts's isRateLimitEnforced() doc comment).
process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

const { initVault } = await bootstrapRouteIntegrationTest()

const DECLARED_LOADED: ExtensionState = {
  status: 'loaded',
  manifest: {
    name: 'test.mock-envelope-extension',
    apiVersion: '1.2.0',
    capabilities: ['auth-provider'],
    replacesNativeLogin: true,
  },
  loadedAt: new Date().toISOString(),
  hooks: {
    authStrategy: {
      onAuthenticate: async () => ({ externalSubject: 'x', providerName: 'test' }),
    },
  },
}

/** Forces the shared native-login-policy module to `disabled` for the current process — the
 * gated routes read the live module state per-request, so this affects the already-created
 * `app` too (no per-test createApp() needed). */
async function forcePolicyDisabled(): Promise<void> {
  await markReplacementProven('test.mock-envelope-extension')
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy(DECLARED_LOADED)
}

async function forcePolicyEnabled(): Promise<void> {
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy({ status: 'not_configured' })
}

const POST = 'POST'
const LOGIN_URL = '/api/v1/auth/login'
const TEST_EMAIL = 'a@example.com'
const TEST_PASSWORD = 'CorrectHorseBattery9!'
const REGISTER_URL = '/api/v1/auth/register'

let app: Awaited<ReturnType<typeof bootUnsealedRouteApp>>['app']
let closeSuite: () => Promise<void>

beforeAll(async () => {
  const suite = await bootUnsealedRouteApp(initVault, 'a-correct-horse-battery-staple-passphrase')
  app = suite.app
  closeSuite = suite.close
})

afterAll(async () => {
  await closeSuite()
})

beforeEach(async () => {
  await forcePolicyEnabled()
  // Deliberately does NOT truncate `users` — this suite shares a database with every other test
  // file in a full run (fileParallelism:false is sequential, not isolated), and other files'
  // rows are FK-referenced from tables like credential_shares. A blanket delete(users) here
  // breaks unrelated tests. Every test below uses randomUUID()-based unique emails/org names
  // instead, matching platform-operator-bootstrap.test.ts's own established convention for the
  // one test that genuinely cares about "was this the first user" (see below).
  //
  // /mfa/recover and /recovery/request share a DB-backed (not RATE_LIMIT_TEST_BYPASS-gated)
  // IP bucket — reset it each test so this suite's own volume of requests never trips it.
  await getDb().execute(sql`DELETE FROM auth_rate_limit_buckets`)
})

/** Number of user rows that existed strictly before `createdAt` — mirrors
 * platform-operator-bootstrap.test.ts's own helper. Robust against concurrently running test
 * files inserting users, unlike asserting the table is empty. */
async function countUsersCreatedBefore(createdAt: Date): Promise<number> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(lt(users.createdAt, createdAt))
  return rows.length
}

describe('Story 23.2 AC-6: native-credential surface fails closed', () => {
  const GATED_CASES: Array<{ name: string; method: string; url: string; body?: unknown }> = [
    {
      name: 'login',
      method: POST,
      url: LOGIN_URL,
      body: { email: TEST_EMAIL, password: 'x' },
    },
    {
      name: 'mfa/verify-login',
      method: POST,
      url: '/api/v1/auth/mfa/verify-login',
      body: { pendingSessionToken: 'x', totpCode: '123456' },
    },
    {
      name: 'mfa/recover',
      method: POST,
      url: '/api/v1/auth/mfa/recover',
      body: { email: TEST_EMAIL, password: 'x', recoveryCode: 'x' },
    },
    {
      name: 'recovery/request',
      method: POST,
      url: '/api/v1/auth/recovery/request',
      body: { email: TEST_EMAIL },
    },
    { name: 'recovery/:token (GET peek)', method: 'GET', url: '/api/v1/auth/recovery/some-token' },
    {
      name: 'recovery/:token/mfa/start',
      method: POST,
      url: '/api/v1/auth/recovery/some-token/mfa/start',
    },
    {
      name: 'recovery/:token/complete',
      method: POST,
      url: '/api/v1/auth/recovery/some-token/complete',
      body: { password: TEST_PASSWORD },
    },
  ]

  for (const testCase of GATED_CASES) {
    it(`${testCase.name}: 403 native_login_disabled when policy is disabled, before any credential work`, async () => {
      await forcePolicyDisabled()
      const res = await app.inject({
        method: testCase.method as 'GET' | 'POST',
        url: testCase.url,
        payload: testCase.body,
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'native_login_disabled' })
    })

    it(`${testCase.name}: unaffected (not 403) when policy is enabled`, async () => {
      await forcePolicyEnabled()
      const res = await app.inject({
        method: testCase.method as 'GET' | 'POST',
        url: testCase.url,
        payload: testCase.body,
      })
      expect(res.statusCode).not.toBe(403)
    })
  }

  it('AC-5: request-supplied fields cannot influence the gate in either direction', async () => {
    await forcePolicyDisabled()
    const res = await app.inject({
      method: POST,
      url: LOGIN_URL,
      headers: { 'x-native-login': 'enabled', 'x-vault-break-glass': 'true' },
      payload: { email: TEST_EMAIL, password: 'x', nativeLoginEnabled: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it("AC-6a bootstrap carve-out: a registration under a disabled policy succeeds iff it is genuinely the first user ever, mirroring Story 9.1 D1/AC-1's own convention", async () => {
    await forcePolicyDisabled()
    const beforeInsert = new Date()
    const res = await app.inject({
      method: POST,
      url: REGISTER_URL,
      payload: {
        email: `bootstrap-${randomUUID()}@example.com`,
        password: TEST_PASSWORD,
        orgName: `bootstrap org ${randomUUID()}`,
      },
    })
    // isFirstUser is resolved from the live table at the moment of insert (never cached), so
    // this reflects whatever this run's actual DB state is — genuinely first in an isolated
    // run of this file, genuinely not-first when run alongside other suites that already
    // populated `users`. Either way, the response must match the real state.
    const priorCount = await countUsersCreatedBefore(beforeInsert)
    const wasFirstUser = priorCount === 0
    expect(res.statusCode).toBe(wasFirstUser ? 201 : 403)
    if (!wasFirstUser) {
      expect(res.json()).toMatchObject({ code: 'native_login_disabled' })
      return
    }

    // AC-6a item 3 / AC-9: the carve-out was genuinely exercised — assert both the warn log
    // (implicitly exercised, not directly observable via app.inject) and the dedicated audit
    // event, with the fixed, no-email payload shape.
    const body = res.json<{ data: { orgId: string; userId: string } }>()
    const [row] = await getDb()
      .execute(
        sql`SELECT payload FROM audit_log_entries WHERE org_id = ${body.data.orgId} AND event_type = ${AuditEvent.NATIVE_LOGIN_BOOTSTRAP_REGISTER_ALLOWED} LIMIT 1`
      )
      .then((result) => result as unknown as { payload: Record<string, unknown> }[])
    expect(row).toBeDefined()
    expect(row?.payload).toEqual({ userId: body.data.userId, isPlatformOperator: true })
  })

  it('AC-6a: a registration that is NOT the first user is gated (native_login_disabled), deterministically', async () => {
    // Register one user under the ENABLED policy first, guaranteeing `users` is non-empty by
    // the time the real test registration runs under the DISABLED policy — deterministic
    // regardless of whatever else is in the shared test database (same technique
    // platform-operator-bootstrap.test.ts uses for its own "not first" test).
    await forcePolicyEnabled()
    const guarantorRes = await app.inject({
      method: POST,
      url: REGISTER_URL,
      payload: {
        email: `bootstrap-guarantor-${randomUUID()}@example.com`,
        password: TEST_PASSWORD,
        orgName: `bootstrap guarantor org ${randomUUID()}`,
      },
    })
    expect(guarantorRes.statusCode).toBe(201)

    await forcePolicyDisabled()
    const res = await app.inject({
      method: POST,
      url: REGISTER_URL,
      payload: {
        email: `bootstrap-second-${randomUUID()}@example.com`,
        password: TEST_PASSWORD,
        orgName: `bootstrap second org ${randomUUID()}`,
      },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'native_login_disabled' })
  })

  // AC-6 finding L2/N15: registerMethodNotAllowed() (routes.ts) is registered for exactly nine
  // paths, four of which are also on the AC-6 gated-routes list: /register, /login,
  // /mfa/verify-login, /mfa/recover. The gate must never shadow that 405 registration — a wrong
  // method still 405s under exclusion, byte-identical to the enabled path.
  it.each([
    { name: 'register', url: REGISTER_URL },
    { name: 'login', url: LOGIN_URL },
    { name: 'mfa/verify-login', url: '/api/v1/auth/mfa/verify-login' },
    { name: 'mfa/recover', url: '/api/v1/auth/mfa/recover' },
  ])(
    '405-preservation: GET $name still returns 405 Method Not Allowed under exclusion, never 403',
    async ({ url }) => {
      await forcePolicyDisabled()
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(405)
      expect(res.json()).toMatchObject({ code: 'method_not_allowed' })
    }
  )

  // AC-6 finding L2: no `registerMethodNotAllowed()` registration exists for any /recovery/*
  // route, gate row #10, or the external-shares route — this story must not add one. The
  // required assertion instead is "wrong-method behavior unchanged from today": byte-identical
  // between the enabled and disabled policy, whatever that behavior happens to be.
  // Deliberately does NOT include GET /recovery/request as a "wrong method" case: fastify's
  // router matches it against the parametric GET /recovery/:token route (token="request") rather
  // than 404ing outright, since there is no static GET handler for /recovery/request specifically
  // to compete with it — that is correct, gate-eligible routing, not a wrong-method gap.
  it.each([
    {
      name: 'recovery/:token (GET-only route, wrong method PUT)',
      method: 'PUT',
      url: '/api/v1/auth/recovery/some-token',
    },
    {
      name: 'recovery/:token/complete (POST-only route, wrong method GET)',
      method: 'GET',
      url: '/api/v1/auth/recovery/some-token/complete',
    },
  ])(
    '405-preservation: $name behaves byte-identically enabled vs. disabled',
    async ({ method, url }) => {
      await forcePolicyEnabled()
      const enabledRes = await app.inject({ method, url })

      await forcePolicyDisabled()
      const disabledRes = await app.inject({ method, url })

      expect(disabledRes.statusCode).toBe(enabledRes.statusCode)
      expect(disabledRes.json()).toEqual(enabledRes.json())
    }
  )
})
