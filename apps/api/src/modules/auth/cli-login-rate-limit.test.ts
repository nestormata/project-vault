import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { auditLogEntries, failedAuthAttempts, orgMemberships } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { totpForSecret } from '../../__tests__/helpers/totp.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import type { ExtensionState } from '../../extensions/loader.js'
import {
  __resetNativeLoginPolicyForTests,
  markReplacementProven,
  resolveNativeLoginPolicy,
} from './native-login-policy.js'

/**
 * Story 43.8: the four CLI auth routes (Story 43.2) are registered by `cliLoginRoutes`, a SIBLING
 * of `authRoutes` in app.ts — so `authRoutes`' own `@fastify/rate-limit` registration never saw
 * them, and their `config.rateLimit` blocks were inert (epic-43 retro Finding 3). Every case here
 * drives the real `createApp()` (the bug is in app.ts's plugin wiring, which a hand-built Fastify
 * instance would not exercise) with `RATE_LIMIT_TEST_BYPASS=false` set BEFORE `createApp()` —
 * `isRateLimitEnforced()` is read at plugin-register time, so flipping it afterwards tests nothing.
 * Each case builds its own app (fresh in-memory LocalStore) and uses its own `remoteAddress`s.
 */
vi.setConfig({ testTimeout: 60_000 })

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
const { env } = await import('../../config/env.js')
type TestApp = Awaited<ReturnType<typeof createApp>>
type InjectResponse = Awaited<ReturnType<TestApp['inject']>>

const TEST_PASSWORD = 'correct-horse-battery-staple'
const WRONG_PASSWORD = 'wrong-password-sentinel'
const TEST_PASSPHRASE = 'cli-login-rate-limit-passphrase'
const LOGIN_URL = '/api/v1/auth/login'
const CLI_LOGIN_URL = '/api/v1/auth/cli-login'
const CLI_VERIFY_URL = '/api/v1/auth/cli/mfa/verify-login'
const CLI_REFRESH_URL = '/api/v1/auth/cli/refresh'
const CLI_LOGOUT_URL = '/api/v1/auth/cli/logout'
const VERIFY_MAX = 20
const REFRESH_MAX = 120
const RATE_LIMIT_BODY = { code: 'rate_limit_exceeded', message: 'Too many authentication attempts' }

let ipCounter = 0
/** A fresh documentation-range IPv4 per call, so buckets can never leak between cases. */
function freshIp(): string {
  ipCounter += 1
  return `198.51.${100 + Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

function uniqueEmail(label: string): string {
  return `cli-rl-${label}-${randomUUID()}@example.com`
}

async function withLimitedApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  let app: TestApp | undefined
  try {
    app = await createApp({ logger: false })
    await fn(app)
  } finally {
    await app?.close()
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  }
}

function post(
  app: TestApp,
  url: string,
  remoteAddress: string,
  payload: unknown = {},
  headers: Record<string, string> = {}
): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url, remoteAddress, payload: payload as object, headers })
}

async function burst(
  app: TestApp,
  url: string,
  remoteAddress: string,
  count: number,
  payload: unknown = {}
): Promise<InjectResponse[]> {
  const responses: InjectResponse[] = []
  for (let i = 0; i < count; i += 1) responses.push(await post(app, url, remoteAddress, payload))
  return responses
}

function statuses(responses: InjectResponse[]): number[] {
  return responses.map((r) => r.statusCode)
}

async function countFailedAttempts(email: string): Promise<number> {
  const rows = await getDb()
    .select({ id: failedAuthAttempts.id })
    .from(failedAuthAttempts)
    .where(eq(failedAuthAttempts.attemptedEmail, email.toLowerCase()))
  return rows.length
}

async function countAuditRows(orgId: string): Promise<number> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: auditLogEntries.id })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.orgId, orgId))
    return rows.length
  })
}

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

async function forcePolicyDisabled(): Promise<void> {
  await markReplacementProven('test.mock-envelope-extension')
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy(DECLARED_LOADED)
}

async function forcePolicyEnabled(): Promise<void> {
  __resetNativeLoginPolicyForTests()
  await resolveNativeLoginPolicy({ status: 'not_configured' })
}

describe('Story 43.8: per-IP rate limiting on the CLI auth routes', () => {
  // A bypass=true app for fixture setup only (registration is itself rate limited at 10/min).
  let setupApp: TestApp
  let plain: { email: string; userId: string; orgId: string }
  let mfa: { email: string; secret: string }

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    setupApp = await createApp({ logger: false })

    const plainEmail = uniqueEmail('plain')
    const registered = await registerAndLoginViaApi(setupApp, {
      email: plainEmail,
      password: TEST_PASSWORD,
      orgName: `Org ${randomUUID()}`,
    })
    plain = { email: plainEmail, userId: registered.userId, orgId: registered.orgId }

    const mfaEmail = uniqueEmail('mfa')
    const mfaUser = await registerAndLoginViaApi(setupApp, {
      email: mfaEmail,
      password: TEST_PASSWORD,
      orgName: `Org ${randomUUID()}`,
    })
    const enroll = await setupApp.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enroll',
      headers: { cookie: cookieHeader(mfaUser.cookies) },
      payload: {},
    })
    expect(enroll.statusCode).toBe(200)
    const secret = enroll.json<{ data: { secret: string } }>().data.secret
    const verifyEnrollment = await setupApp.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify-enrollment',
      headers: { cookie: cookieHeader(mfaUser.cookies) },
      payload: { totp: totpForSecret(secret) },
    })
    expect(verifyEnrollment.statusCode).toBe(200)
    await withOrg(mfaUser.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ gracePeriodExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(orgMemberships.userId, mfaUser.userId))
    )
    mfa = { email: mfaEmail, secret }
  })

  afterAll(async () => {
    await forcePolicyEnabled()
    await setupApp?.close()
    await resetVaultForTest()
  })

  describe('AC-1: the password path of /cli-login is throttled', () => {
    it('request 60 (well-formed) is 401 and request 61 (well-formed) is 429 inside one window', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const start = Date.now()
        const bulk = await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX - 1)
        const wellFormed = { email: `nobody-${randomUUID()}@example.com`, password: WRONG_PASSWORD }
        const last = await post(app, CLI_LOGIN_URL, ip, wellFormed)
        const overLimit = await post(app, CLI_LOGIN_URL, ip, wellFormed)

        expect(new Set(statuses(bulk))).toEqual(new Set([422]))
        expect(last.statusCode).toBe(401)
        expect(last.json()).toMatchObject({ code: 'invalid_credentials' })
        expect(overLimit.statusCode).toBe(429)
        expect(
          Date.now() - start,
          'burst took too long — it may have straddled the 60 s rate-limit window'
        ).toBeLessThan(45_000)
      })
    })
  })

  describe('AC-2: each CLI route enforces its own per-IP budget', () => {
    it('/cli-login: exactly AUTH_RATE_LIMIT_MAX allowed, the next one is 429', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses = await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX + 1)
        expect(statuses(responses.slice(0, -1)).includes(429)).toBe(false)
        expect(responses.at(-1)?.statusCode).toBe(429)
      })
    })

    it('/cli/mfa/verify-login: 20 allowed, the 21st is 429', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses = await burst(app, CLI_VERIFY_URL, ip, VERIFY_MAX + 1)
        expect(new Set(statuses(responses.slice(0, -1)))).toEqual(new Set([422]))
        expect(responses.at(-1)?.statusCode).toBe(429)
      })
    })

    it('/cli/refresh: 120 allowed, the 121st is 429', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses = await burst(app, CLI_REFRESH_URL, ip, REFRESH_MAX + 1)
        expect(new Set(statuses(responses.slice(0, -1)))).toEqual(new Set([422]))
        expect(responses.at(-1)?.statusCode).toBe(429)
      })
    })

    it('/cli/logout: AUTH_RATE_LIMIT_MAX allowed ({ revoked: false }), the next one is 429', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses = await burst(app, CLI_LOGOUT_URL, ip, env.AUTH_RATE_LIMIT_MAX + 1)
        expect(new Set(statuses(responses.slice(0, -1)))).toEqual(new Set([200]))
        expect(responses.at(-2)?.json()).toEqual({ data: { revoked: false } })
        expect(responses.at(-1)?.statusCode).toBe(429)
      })
    })

    it('happy path: cli-login -> verify-login -> refresh -> logout from one IP all succeed', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const challenge = await post(app, CLI_LOGIN_URL, ip, {
          email: mfa.email,
          password: TEST_PASSWORD,
        })
        expect(challenge.statusCode).toBe(200)
        const { mfaToken } = challenge.json<{ data: { mfaToken: string } }>().data
        const verify = await post(app, CLI_VERIFY_URL, ip, {
          mfaToken,
          totp: totpForSecret(mfa.secret, Date.now() + 30_000),
        })
        expect(verify.statusCode).toBe(200)
        const { refreshToken } = verify.json<{ data: { refreshToken: string } }>().data
        const refresh = await post(app, CLI_REFRESH_URL, ip, { refreshToken })
        expect(refresh.statusCode).toBe(200)
        const rotated = refresh.json<{ data: { refreshToken: string } }>().data.refreshToken
        const logout = await post(app, CLI_LOGOUT_URL, ip, { refreshToken: rotated })
        expect(logout.statusCode).toBe(200)
        expect(logout.json()).toEqual({ data: { revoked: true } })
      })
    })

    it('per-route buckets are independent: an exhausted route does not limit its siblings', async () => {
      await withLimitedApp(async (app) => {
        const ipA = freshIp()
        const verify = await burst(app, CLI_VERIFY_URL, ipA, VERIFY_MAX + 1)
        expect(verify.at(-1)?.statusCode).toBe(429)
        expect((await post(app, CLI_LOGIN_URL, ipA)).statusCode).toBe(422)
        expect((await post(app, CLI_REFRESH_URL, ipA)).statusCode).toBe(422)
        expect((await post(app, CLI_LOGOUT_URL, ipA)).statusCode).toBe(200)

        const ipB = freshIp()
        const login = await burst(app, CLI_LOGIN_URL, ipB, env.AUTH_RATE_LIMIT_MAX + 1)
        expect(login.at(-1)?.statusCode).toBe(429)
        expect((await post(app, CLI_REFRESH_URL, ipB)).statusCode).toBe(422)
        expect((await post(app, CLI_LOGOUT_URL, ipB)).statusCode).toBe(200)
      })
    })

    it('Decision D4: /cli-login and the browser /login keep separate per-IP buckets', async () => {
      await withLimitedApp(async (app) => {
        const ipA = freshIp()
        const cli = await burst(app, CLI_LOGIN_URL, ipA, env.AUTH_RATE_LIMIT_MAX + 1)
        expect(cli.at(-1)?.statusCode).toBe(429)
        expect((await post(app, LOGIN_URL, ipA)).statusCode).not.toBe(429)

        const ipB = freshIp()
        const browser = await burst(app, LOGIN_URL, ipB, env.AUTH_RATE_LIMIT_MAX + 1)
        expect(browser.at(-1)?.statusCode).toBe(429)
        expect((await post(app, CLI_LOGIN_URL, ipB)).statusCode).not.toBe(429)
      })
    })

    it('concurrent burst: 70 parallel /cli-login requests from one IP never get more than max through', async () => {
      // @fastify/rate-limit@11.2.0's LocalStore hands every caller the SAME mutable counter object,
      // so requests that interleave between `incr` and the plugin's read of `current` all see the
      // final count: a same-tick burst over-counts (fails closed) rather than being exact. The
      // security invariant is the upper bound — never more than `max` requests reach the handler.
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses = await Promise.all(
          Array.from({ length: env.AUTH_RATE_LIMIT_MAX + 10 }, () => post(app, CLI_LOGIN_URL, ip))
        )
        const limited = responses.filter((r) => r.statusCode === 429)
        expect(limited.length).toBeGreaterThanOrEqual(10)
        expect(responses.length - limited.length).toBeLessThanOrEqual(env.AUTH_RATE_LIMIT_MAX)
      })
    })

    it('RATE_LIMIT_TEST_BYPASS=true under NODE_ENV=test still disables the limiter', async () => {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
      const app = await createApp({ logger: false })
      try {
        const ip = freshIp()
        const responses = await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX + 1)
        expect(statuses(responses).includes(429)).toBe(false)
      } finally {
        await app.close()
      }
    })
  })

  describe('AC-3: the limit is per IP, independent of account, org and body', () => {
    it('another IP is unaffected while the exhausted IP stays limited', async () => {
      await withLimitedApp(async (app) => {
        const ipA = freshIp()
        await burst(app, CLI_LOGIN_URL, ipA, env.AUTH_RATE_LIMIT_MAX)
        const ipB = freshIp()
        const other = await post(app, CLI_LOGIN_URL, ipB, {
          email: plain.email,
          password: TEST_PASSWORD,
        })
        expect(other.statusCode).toBe(200)
        expect(other.json<{ data: { tokenType: string } }>().data.tokenType).toBe('Bearer')
        expect((await post(app, CLI_LOGIN_URL, ipA)).statusCode).toBe(429)
      })
    })

    it('the key ignores the account: different emails from one IP share the bucket', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses: InjectResponse[] = []
        for (let i = 0; i <= env.AUTH_RATE_LIMIT_MAX; i += 1) {
          // Distinct nonexistent accounts, but a malformed password keeps each one a cheap 422.
          responses.push(await post(app, CLI_LOGIN_URL, ip, { email: uniqueEmail(`spray-${i}`) }))
        }
        expect(statuses(responses.slice(0, -1)).includes(429)).toBe(false)
        expect(responses.at(-1)?.statusCode).toBe(429)
      })
    })

    it('the per-account lockout still works independently of the per-IP budget', async () => {
      const victim = uniqueEmail('victim')
      await registerAndLoginViaApi(setupApp, {
        email: victim,
        password: TEST_PASSWORD,
        orgName: `Org ${randomUUID()}`,
      })
      await withLimitedApp(async (app) => {
        const ipB = freshIp()
        for (let i = 0; i < env.LOGIN_LOCKOUT_THRESHOLD; i += 1) {
          const res = await post(app, CLI_LOGIN_URL, ipB, {
            email: victim,
            password: WRONG_PASSWORD,
          })
          expect(res.statusCode).toBe(401)
        }
        const correct = await post(app, CLI_LOGIN_URL, ipB, {
          email: victim,
          password: TEST_PASSWORD,
        })
        expect(correct.statusCode).toBe(401)
        expect(correct.json()).toMatchObject({ code: 'invalid_credentials' })
      })
    })

    it('a 429 writes no failed_auth_attempts and no audit rows, and never distinguishes a real account', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX)
        const failedBefore = await countFailedAttempts(plain.email)
        const auditBefore = await countAuditRows(plain.orgId)

        const limited: InjectResponse[] = []
        for (let i = 0; i < 5; i += 1) {
          limited.push(
            await post(app, CLI_LOGIN_URL, ip, { email: plain.email, password: WRONG_PASSWORD })
          )
        }
        const unknown = await post(app, CLI_LOGIN_URL, ip, {
          email: `nobody-${randomUUID()}@example.com`,
          password: WRONG_PASSWORD,
        })

        expect(new Set(statuses(limited))).toEqual(new Set([429]))
        expect(await countFailedAttempts(plain.email)).toBe(failedBefore)
        expect(await countAuditRows(plain.orgId)).toBe(auditBefore)
        expect(unknown.statusCode).toBe(429)
        expect(JSON.stringify(unknown.json())).toBe(JSON.stringify(limited[0]?.json()))
        expect(limited[0]?.json()).toStrictEqual(RATE_LIMIT_BODY)
      })
    })
  })

  describe('AC-4: headers cannot mint new buckets (TRUST_PROXY=false default)', () => {
    it('a different X-Forwarded-For / X-Real-IP per request from one socket still hits 429', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses: InjectResponse[] = []
        for (let i = 0; i <= env.AUTH_RATE_LIMIT_MAX; i += 1) {
          responses.push(
            await post(
              app,
              CLI_LOGIN_URL,
              ip,
              {},
              {
                'x-forwarded-for': `10.0.0.${i + 1}`,
                'x-real-ip': `10.0.1.${i + 1}`,
              }
            )
          )
        }
        expect(responses.at(-1)?.statusCode).toBe(429)
      })
    })
  })

  describe('AC-5: one documented 429 contract, evaluated before the gate, body parsing and validation', () => {
    it('the over-limit response is exactly the documented 429 (never a 500)', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        const responses = await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX + 1)
        const first = responses[0]
        const last = responses.at(-1)
        expect(first?.headers['x-ratelimit-limit']).toBe(String(env.AUTH_RATE_LIMIT_MAX))
        expect(first?.headers['x-ratelimit-remaining']).toBe(String(env.AUTH_RATE_LIMIT_MAX - 1))
        expect(last?.statusCode).toBe(429)
        expect(last?.json()).toStrictEqual(RATE_LIMIT_BODY)
        expect(last?.headers['x-ratelimit-remaining']).toBe('0')
        const retryAfter = Number(last?.headers['retry-after'])
        expect(Number.isInteger(retryAfter)).toBe(true)
        expect(retryAfter).toBeGreaterThanOrEqual(1)
        expect(retryAfter).toBeLessThanOrEqual(60)
      })
    })

    it('over-limit beats 403 native_login_disabled on /cli-login and /cli/mfa/verify-login', async () => {
      await withLimitedApp(async (app) => {
        await forcePolicyDisabled()
        try {
          const ip = freshIp()
          const login = await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX + 1, {
            email: uniqueEmail('someone'),
            password: WRONG_PASSWORD,
          })
          expect(login[0]?.statusCode).toBe(403)
          expect(login.at(-1)?.statusCode).toBe(429)
          const verify = await burst(app, CLI_VERIFY_URL, ip, VERIFY_MAX + 1)
          expect(verify[0]?.statusCode).toBe(403)
          expect(verify.at(-1)?.statusCode).toBe(429)
        } finally {
          await forcePolicyEnabled()
        }
      })
    })

    it('over-limit beats malformed (400/422) and oversized (413) bodies', async () => {
      await withLimitedApp(async (app) => {
        const ip = freshIp()
        await burst(app, CLI_LOGIN_URL, ip, env.AUTH_RATE_LIMIT_MAX)
        const malformed = await app.inject({
          method: 'POST',
          url: CLI_LOGIN_URL,
          remoteAddress: ip,
          headers: { 'content-type': 'application/json' },
          payload: '{not json',
        })
        const oversized = await post(app, CLI_LOGIN_URL, ip, { email: 'x'.repeat(10_000) })
        expect(malformed.statusCode).toBe(429)
        expect(oversized.statusCode).toBe(429)
      })
    })
  })
})
