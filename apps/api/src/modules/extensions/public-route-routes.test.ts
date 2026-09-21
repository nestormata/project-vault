import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'
import type {
  ActionResult,
  PublicRouteHooks,
  PublicRouteResult,
} from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  bootUnsealedRouteApp,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  __resetExtensionStateForTests,
  __setExtensionStateForTests,
} from '../../extensions/loader.js'
import type { ExtensionState } from '../../extensions/loader.js'

/**
 * Story 20.13 Task 4 — real-mounted-route coverage for `publicRouteRoutes`, mirroring
 * `module-data-routes.test.ts`'s own "set extension state BEFORE boot, since route existence is
 * decided at registration time" precedent (this mechanism shares that same load-bearing ordering
 * fact — see `public-route-routes.ts`'s own doc comment) plus `oauth-handoff-routes.test.ts`'s
 * timeout/malformed/rejection coverage shape, adapted for this mechanism's own path-allow-list and
 * capability-gating concerns instead of `oauthHandoff`'s pending-state-cookie concerns.
 */

const { initVault } = await bootstrapRouteIntegrationTest()
const TEST_PASSPHRASE = 'public-route-routes-passphrase'

type TestApp = Awaited<ReturnType<typeof import('../../app.js').createApp>>

function loadedStateWithPublicRoute(overrides: {
  capabilities?: string[]
  anonymousRoutePaths?: string[]
  publicRoute?: PublicRouteHooks
  name?: string
}): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: overrides.name ?? 'com.example.public-route-fixture',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? ['public-route']) as never,
      ...(overrides.anonymousRoutePaths
        ? { anonymousRoutePaths: overrides.anonymousRoutePaths }
        : {}),
    },
    loadedAt: new Date().toISOString(),
    hooks: {
      ...(overrides.publicRoute ? { publicRoute: overrides.publicRoute } : {}),
    },
  }
}

const REDEEM_PATH_TEMPLATE = '/pv-public-test/redeem/:token'
const REDEEM_URL = '/pv-public-test/redeem/abc123'
const STATUS_PATH_TEMPLATE = '/pv-public-test/status'
const BOOM_PATH_TEMPLATE = '/pv-public-test/boom'
const SLOW_PATH_TEMPLATE = '/pv-public-test/slow'
const MALFORMED_PATH_TEMPLATE = '/pv-public-test/malformed'
const BAD_STATUS_PATH_TEMPLATE = '/pv-public-test/bad-status'
const BAD_HEADER_PATH_TEMPLATE = '/pv-public-test/bad-header'
const REDIRECT_STATUS_PATH_TEMPLATE = '/pv-public-test/redirect-status'

describe('GET <declared path template> — Story 20.13 AC1-AC5 (real mounted route)', () => {
  let app: TestApp
  let closeApp: () => Promise<void>
  let onPublicRouteRequest: PublicRouteHooks['onPublicRouteRequest'] & ReturnType<typeof vi.fn>

  beforeAll(async () => {
    onPublicRouteRequest = vi.fn(async (request): Promise<PublicRouteResult | ActionResult> => {
      if (request.pathTemplate === BOOM_PATH_TEMPLATE) {
        throw new Error('should never leak this text')
      }
      if (request.pathTemplate === SLOW_PATH_TEMPLATE) {
        await new Promise(() => undefined) // never resolves — exercises the timeout path
      }
      if (request.pathTemplate === MALFORMED_PATH_TEMPLATE) {
        return 'not-an-object' as never
      }
      if (request.pathTemplate === BAD_STATUS_PATH_TEMPLATE) {
        return { outcome: 'response' as const, status: 999, body: {} }
      }
      if (request.pathTemplate === BAD_HEADER_PATH_TEMPLATE) {
        return {
          outcome: 'response' as const,
          status: 200,
          headers: { 'x-injected': 'value\r\nX-Evil: header' },
          body: {},
        }
      }
      if (request.pathTemplate === REDIRECT_STATUS_PATH_TEMPLATE) {
        return {
          outcome: 'response' as const,
          status: 302,
          headers: { location: '/elsewhere' },
          body: {},
        }
      }
      return {
        outcome: 'response' as const,
        status: 200,
        headers: { 'x-custom': 'yes', 'set-cookie': 'evil=1' },
        body: { token: request.params['token'] ?? null, q: request.query['q'] ?? null },
      }
    })

    __setExtensionStateForTests(
      loadedStateWithPublicRoute({
        anonymousRoutePaths: [
          REDEEM_PATH_TEMPLATE,
          STATUS_PATH_TEMPLATE,
          BOOM_PATH_TEMPLATE,
          SLOW_PATH_TEMPLATE,
          MALFORMED_PATH_TEMPLATE,
          BAD_STATUS_PATH_TEMPLATE,
          BAD_HEADER_PATH_TEMPLATE,
          REDIRECT_STATUS_PATH_TEMPLATE,
        ],
        publicRoute: { onPublicRouteRequest },
      })
    )
    const suite = await bootUnsealedRouteApp(initVault, TEST_PASSPHRASE)
    app = suite.app
    closeApp = suite.close
  })

  afterAll(async () => {
    await closeApp()
    __resetExtensionStateForTests()
  })

  afterEach(() => {
    onPublicRouteRequest.mockClear()
  })

  it('AC1/AC3: a declared path template dispatches to the hook, unauthenticated, and translates a response outcome to a real HTTP response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pv-public-test/redeem/abc123?q=hello',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ token: 'abc123', q: 'hello' })
    expect(res.headers['x-custom']).toBe('yes')
    // AC4: Set-Cookie is stripped unconditionally — no session concept on this anonymous path.
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('AC1: literal path templates match literal-beats-:param precedence (Design Decision B)', async () => {
    const res = await app.inject({ method: 'GET', url: STATUS_PATH_TEMPLATE })
    expect(res.statusCode).toBe(200)
    expect(onPublicRouteRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pathTemplate: STATUS_PATH_TEMPLATE, params: {} })
    )
  })

  it('AC3: an undeclared path 404s non-enumerating, never reaching the hook', async () => {
    const res = await app.inject({ method: 'GET', url: '/pv-public-test/not-declared' })
    expect(res.statusCode).toBe(404)
    expect(onPublicRouteRequest).not.toHaveBeenCalled()
  })

  it('AC4 edge case: a non-GET request to a declared path 404s the same non-enumerating way, never invoking the hook', async () => {
    const res = await app.inject({ method: 'POST', url: REDEEM_URL })
    expect(res.statusCode).toBe(404)
    expect(onPublicRouteRequest).not.toHaveBeenCalled()
  })

  it('AC5: a thrown hook error produces a generic 500, never leaking the extension error text', async () => {
    const res = await app.inject({ method: 'GET', url: BOOM_PATH_TEMPLATE })
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.json())).not.toContain('should never leak this text')
  })

  it('AC5: a malformed hook result produces a generic 500', async () => {
    const res = await app.inject({ method: 'GET', url: MALFORMED_PATH_TEMPLATE })
    expect(res.statusCode).toBe(500)
  })

  it('code review fix (AC4/AC5): an out-of-range status code is rejected as malformed, not thrown past the route', async () => {
    const res = await app.inject({ method: 'GET', url: BAD_STATUS_PATH_TEMPLATE })
    expect(res.statusCode).toBe(500)
  })

  it('code review fix (AC4/AC5): a header value containing CRLF is rejected as malformed, not thrown past the route', async () => {
    const res = await app.inject({ method: 'GET', url: BAD_HEADER_PATH_TEMPLATE })
    expect(res.statusCode).toBe(500)
  })

  it('code review fix (Design Decision C): a hook result with a 3xx redirect status is rejected as malformed — no redirect outcome in v1', async () => {
    const res = await app.inject({ method: 'GET', url: REDIRECT_STATUS_PATH_TEMPLATE })
    expect(res.statusCode).toBe(500)
  })

  it('code review fix (AC5 non-enumeration): the denial body for an undeclared path uses the same shape as a genuine Sec-Fetch-Mode rejection on a declared path — no distinguishable oracle', async () => {
    const undeclared = await app.inject({ method: 'GET', url: '/pv-public-test/not-declared' })
    const rejectedByFetchMode = await app.inject({
      method: 'GET',
      url: REDEEM_URL,
      headers: { 'sec-fetch-mode': 'cors' },
    })
    expect(undeclared.statusCode).toBe(404)
    expect(rejectedByFetchMode.statusCode).toBe(404)
    const undeclaredBody = undeclared.json() as Record<string, unknown>
    const rejectedBody = rejectedByFetchMode.json() as Record<string, unknown>
    // Same key set, same 'error'/'statusCode' values — the only field that legitimately differs
    // is 'message', since it echoes back the request's own path (true of Fastify's own genuine
    // not-found response too, not a mechanism-specific leak).
    expect(Object.keys(undeclaredBody).sort()).toEqual(Object.keys(rejectedBody).sort())
    expect(undeclaredBody['error']).toBe(rejectedBody['error'])
    expect(undeclaredBody['statusCode']).toBe(rejectedBody['statusCode'])
    expect(undeclaredBody).not.toHaveProperty('code')
  })

  it('AC5: a hook that never resolves times out to a generic 500', async () => {
    vi.useFakeTimers()
    try {
      const promise = app.inject({ method: 'GET', url: SLOW_PATH_TEMPLATE })
      await vi.advanceTimersByTimeAsync(10_001)
      const res = await promise
      expect(res.statusCode).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC5: a background fetch (Sec-Fetch-Mode != navigate) is rejected the same non-enumerating way', async () => {
    const res = await app.inject({
      method: 'GET',
      url: REDEEM_URL,
      headers: { 'sec-fetch-mode': 'cors' },
    })
    expect(res.statusCode).toBe(404)
    expect(onPublicRouteRequest).not.toHaveBeenCalled()
  })

  it('AC5b: the route is IP-scoped rate-limited (mirrors external-access-routes.ts)', async () => {
    // bootstrapRouteIntegrationTest() sets RATE_LIMIT_TEST_BYPASS=true globally so unrelated
    // suites don't trip shared buckets — opt back into real enforcement for this one test,
    // mirroring theming/routes.test.ts's own established precedent.
    const previousBypass = process.env['RATE_LIMIT_TEST_BYPASS']
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
      let lastStatus = 200
      for (let i = 0; i < 61; i += 1) {
        const res = await app.inject({ method: 'GET', url: STATUS_PATH_TEMPLATE }) // sequential by design: proving a real cumulative rate-limit window, not concurrency
        lastStatus = res.statusCode
      }
      expect(lastStatus).toBe(429)
    } finally {
      if (previousBypass === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
      else process.env['RATE_LIMIT_TEST_BYPASS'] = previousBypass
    }
  })
})

const FRESH_STATUS_PATH_TEMPLATE = '/pv-public-test-fresh/status'

describe('GET <declared path template> — Story 20.13 AC2 (capability/hook re-checked fresh per request)', () => {
  let app: TestApp
  let closeApp: () => Promise<void>

  afterEach(async () => {
    await closeApp()
    __resetExtensionStateForTests()
  })

  it('AC2: a capability that is withdrawn after registration is re-checked fresh — the route 404s, not a stale 200', async () => {
    const onPublicRouteRequest = vi.fn(async () => ({ outcome: 'response' as const, status: 200 }))
    __setExtensionStateForTests(
      loadedStateWithPublicRoute({
        anonymousRoutePaths: [FRESH_STATUS_PATH_TEMPLATE],
        publicRoute: { onPublicRouteRequest },
      })
    )
    const suite = await bootUnsealedRouteApp(initVault, TEST_PASSPHRASE)
    app = suite.app
    closeApp = suite.close

    const before = await app.inject({ method: 'GET', url: FRESH_STATUS_PATH_TEMPLATE })
    expect(before.statusCode).toBe(200)

    // Simulate the capability being withdrawn (or the extension unloading) without the route
    // table being re-registered — AC2 requires the authorization decision, not just the route's
    // existence, to be re-derived fresh on every request.
    __setExtensionStateForTests(
      loadedStateWithPublicRoute({
        capabilities: [],
        anonymousRoutePaths: [FRESH_STATUS_PATH_TEMPLATE],
        publicRoute: { onPublicRouteRequest },
      })
    )

    const after = await app.inject({ method: 'GET', url: FRESH_STATUS_PATH_TEMPLATE })
    expect(after.statusCode).toBe(404)
    expect(onPublicRouteRequest).toHaveBeenCalledTimes(1)
  })
})

describe('GET <any path> — Story 20.13 AC3 (no extension loaded)', () => {
  let app: TestApp
  let closeApp: () => Promise<void>

  beforeAll(async () => {
    __resetExtensionStateForTests()
    const suite = await bootUnsealedRouteApp(initVault, TEST_PASSPHRASE)
    app = suite.app
    closeApp = suite.close
  })

  afterAll(async () => {
    await closeApp()
  })

  it('mounts zero routes when no extension is loaded: any path 404s, not 503', async () => {
    const res = await app.inject({ method: 'GET', url: '/pv-public-test/anything' })
    expect(res.statusCode).toBe(404)
  })
})
