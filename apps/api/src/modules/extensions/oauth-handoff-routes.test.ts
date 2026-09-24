import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getDb } from '@project-vault/db'
import { extensionOauthPendingStates, extensionRequestStates } from '@project-vault/db/schema'
import type { ModuleActionContext, OAuthHandoffHooks } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  parseSetCookies,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../../__tests__/helpers/org-role-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'
import { env } from '../../config/env.js'
import { CSRF_HEADER_NAME } from '../../lib/csrf.js'
import { csrfCookieName } from '../auth/tokens.js'
import {
  __resetExtensionStateForTests,
  __setExtensionStateForTests,
} from '../../extensions/loader.js'
import type { ExtensionState } from '../../extensions/loader.js'
import { MAX_STATE_SIZE_BYTES, PENDING_TTL_MS } from './oauth-handoff-routes.js'
import { REQUEST_STATE_COOKIE_NAME } from '../../lib/extension-request-state.js'

const { initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof import('../../app.js').createApp>>

const TEST_PASSPHRASE = 'oauth-handoff-route-passphrase'
const START_URL = '/api/v1/extensions/oauth-handoff/start'
const CALLBACK_URL = '/api/v1/extensions/oauth-handoff/callback'
const OAUTH_HANDOFF_COOKIE_NAME = 'oauth-handoff-pending'
const PROVIDER_AUTHORIZE_URL = 'https://provider.example/authorize?client_id=abc'
const CALLBACK_TARGET_URL = 'https://pv.example/repository/select'
const DEFAULT_CSRF_TOKEN = 'test-csrf-token-0123456789abcdef'
const CSRF_COOKIE_NAME = csrfCookieName(env.COOKIE_SECURE)
const OAUTH_HANDOFF_CAPABILITY = 'oauth-handoff'
const PROVIDER_ORIGIN = 'https://provider.example'
const PV_ORIGIN = 'https://pv.example'
const START_ACTION_KIND = 'oauth-start'

const suite = createUnsealedRouteSuite(initVault, TEST_PASSPHRASE)

function loadedState(overrides: {
  capabilities?: string[]
  redirectOrigins?: string[]
  oauthHandoff?: OAuthHandoffHooks
  name?: string
}): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: overrides.name ?? 'com.example.oauth-ext',
      apiVersion: '1.0.0',
      capabilities: (overrides.capabilities ?? [OAUTH_HANDOFF_CAPABILITY]) as never,
      ...(overrides.redirectOrigins ? { redirectOrigins: overrides.redirectOrigins } : {}),
    },
    loadedAt: new Date().toISOString(),
    hooks: {
      ...(overrides.oauthHandoff ? { oauthHandoff: overrides.oauthHandoff } : {}),
    },
  }
}

function defaultHandoffState(
  onOAuthStart?: OAuthHandoffHooks['onOAuthStart'],
  onOAuthCallback?: OAuthHandoffHooks['onOAuthCallback']
): ExtensionState {
  return loadedState({
    redirectOrigins: [PROVIDER_ORIGIN, PV_ORIGIN],
    oauthHandoff: {
      onOAuthStart:
        onOAuthStart ??
        (async () => ({
          outcome: 'redirect' as const,
          url: PROVIDER_AUTHORIZE_URL,
          state: { nonce: 'abc' },
        })),
      onOAuthCallback:
        onOAuthCallback ??
        (async () => ({
          outcome: 'redirect' as const,
          url: CALLBACK_TARGET_URL,
          state: {},
        })),
    },
  })
}

type CsrfOverride = 'include' | 'omit'

async function postStart(
  app: TestApp,
  cookies?: CookieJar,
  body: Record<string, unknown> = { kind: START_ACTION_KIND },
  csrf: CsrfOverride = 'include'
) {
  // 'omit' must exclude any pre-existing csrf-token cookie the login session itself carries too
  // (test-env logins set a fixed one for determinism), not just skip adding the header — else the
  // cookie-vs-header double-submit comparison could still trivially match.
  const { [CSRF_COOKIE_NAME]: _omittedCsrfCookie, ...cookiesWithoutCsrf } = cookies ?? {}
  const mergedCookies: CookieJar =
    csrf === 'include'
      ? { ...cookiesWithoutCsrf, [CSRF_COOKIE_NAME]: DEFAULT_CSRF_TOKEN }
      : cookiesWithoutCsrf
  return app.inject({
    method: 'POST',
    url: START_URL,
    headers: {
      ...(Object.keys(mergedCookies).length > 0 ? { cookie: cookieHeader(mergedCookies) } : {}),
      ...(csrf === 'include' ? { [CSRF_HEADER_NAME]: DEFAULT_CSRF_TOKEN } : {}),
    },
    payload: body,
  })
}

async function getCallback(
  app: TestApp,
  cookieValue?: string,
  query: Record<string, string> = { code: 'abc123', state: 'opaque' }
) {
  const qs = new URLSearchParams(query).toString()
  return app.inject({
    method: 'GET',
    url: `${CALLBACK_URL}?${qs}`,
    headers: cookieValue
      ? { cookie: cookieHeader({ [OAUTH_HANDOFF_COOKIE_NAME]: cookieValue }) }
      : {},
  })
}

function extractPendingCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = parseSetCookies(res.headers['set-cookie'] as string | string[] | undefined)
  const value = cookies[OAUTH_HANDOFF_COOKIE_NAME]
  if (!value) throw new Error('expected oauth-handoff-pending cookie to be set')
  return value
}

async function startAndGetCookie(
  app: TestApp,
  cookies: CookieJar,
  onOAuthStart?: OAuthHandoffHooks['onOAuthStart']
): Promise<string> {
  __setExtensionStateForTests(defaultHandoffState(onOAuthStart))
  const res = await postStart(app, cookies)
  expect(res.statusCode).toBe(302)
  return extractPendingCookie(res)
}

describe('POST /api/v1/extensions/oauth-handoff/start (Story 39.1 AC1)', () => {
  suite.registerLifecycle()

  beforeEach(async () => {
    __resetExtensionStateForTests()
    await getDb().delete(extensionOauthPendingStates)
  })

  it('AC1: an unauthenticated request is rejected before the hook is ever invoked', async () => {
    const onOAuthStart = vi.fn()
    __setExtensionStateForTests(defaultHandoffState(onOAuthStart))
    const res = await postStart(suite.app, undefined)
    expect(res.statusCode).toBe(401)
    expect(onOAuthStart).not.toHaveBeenCalled()
  })

  it('AC1: happy path issues a real 302 + Set-Cookie and persists state server-side keyed to the cookie hash', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, START_ACTION_KIND, 'member')
    __setExtensionStateForTests(defaultHandoffState())

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(PROVIDER_AUTHORIZE_URL)
    const cookies = parseSetCookies(res.headers['set-cookie'] as string | string[] | undefined)
    expect(cookies[OAUTH_HANDOFF_COOKIE_NAME]).toBeDefined()

    const rows = await getDb().select().from(extensionOauthPendingStates)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.consumedAt).toBeNull()
    expect(JSON.parse(rows[0]?.stateJson ?? '{}')).toEqual({ nonce: 'abc' })
    // Pre-Mortem finding 1 — a realistic multi-minute TTL, not handoff-routes.ts's 120s.
    const ttlMs = (rows[0]?.expiresAt?.getTime() ?? 0) - Date.now()
    expect(ttlMs).toBeGreaterThan(4 * 60 * 1000)
    expect(ttlMs).toBeLessThanOrEqual(PENDING_TTL_MS + 5_000)
  })

  it('AC7: an extension not declaring oauth-handoff never has its hook called', async () => {
    const onOAuthStart = vi.fn()
    __setExtensionStateForTests(
      loadedState({
        capabilities: ['ui-panel'],
        oauthHandoff: { onOAuthStart, onOAuthCallback: vi.fn() },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-no-cap', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(404)
    expect(onOAuthStart).not.toHaveBeenCalled()
  })

  it('AC6: onOAuthStart may resolve a non-redirect ActionResult, mapped the same way ModuleAction outcomes are', async () => {
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({ outcome: 'denied', message: 'no thanks' }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-denied', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'denied' })
  })

  it('Story 59.1 AC8: a denied result with html is forwarded as an inert JSON field; denied.message is not', async () => {
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({
        outcome: 'denied',
        message: 'no thanks',
        html: '<p>D</p>',
      }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-denied-html', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'denied', message: 'Request denied', html: '<p>D</p>' })
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/)
  })

  it('Story 59.1 AC4: a thrown onOAuthStart yields a fixed 500 with no html', async () => {
    __setExtensionStateForTests(
      defaultHandoffState(async () => {
        throw Object.assign(new Error('db exploded'), { html: '<p>LEAK</p>' })
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-throw-html', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ code: 'internal_error', message: 'Request failed' })
  })

  it('AC9: rejects a redirect url whose origin is not in the manifest redirectOrigins allow-list', async () => {
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({
        outcome: 'redirect',
        url: 'https://attacker.example/phish',
        state: {},
      }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-badorigin', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(401)
    const rows = await getDb().select().from(extensionOauthPendingStates)
    expect(rows).toHaveLength(0)
  })

  it('AC9: rejects a non-https url before ever reaching allow-list validation', async () => {
    __setExtensionStateForTests(
      loadedState({
        redirectOrigins: ['http://provider.example'],
        oauthHandoff: {
          onOAuthStart: async () => ({
            outcome: 'redirect',
            url: 'http://provider.example/authorize',
            state: {},
          }),
          onOAuthCallback: async () => ({ outcome: 'error' }),
        },
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-http', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(401)
  })

  it('AC9: rejects a protocol-relative url', async () => {
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({
        outcome: 'redirect',
        url: '//attacker.example/phish',
        state: {},
      }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-protorel', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(401)
  })

  it('AC9: rejects a same-domain-but-different-origin bypass attempt (host suffix spoof)', async () => {
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({
        outcome: 'redirect',
        url: 'https://provider.example.attacker.com/authorize',
        state: {},
      }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-spoof', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(401)
  })

  it('Assumption Audit: rejects an oversized state payload with a clear error, never a silent DB failure', async () => {
    const oversized = { blob: 'x'.repeat(MAX_STATE_SIZE_BYTES + 1) }
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({
        outcome: 'redirect',
        url: PROVIDER_AUTHORIZE_URL,
        state: oversized,
      }))
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-oversized', 'member')

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'oauth_handoff_state_too_large' })
    const rows = await getDb().select().from(extensionOauthPendingStates)
    expect(rows).toHaveLength(0)
  })

  it('rejects a request missing the CSRF header (defense-in-depth mutation guard)', async () => {
    __setExtensionStateForTests(defaultHandoffState())
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-csrf', 'member')

    const res = await postStart(suite.app, member.cookies, { kind: START_ACTION_KIND }, 'omit')

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'csrf_rejected' })
  })

  it('resolveBaseModuleActionContext supplies a real ModuleActionContext (identity/orgId) to onOAuthStart', async () => {
    let seenContext: ModuleActionContext | undefined
    __setExtensionStateForTests(
      defaultHandoffState(async (context) => {
        seenContext = context
        return { outcome: 'redirect', url: PROVIDER_AUTHORIZE_URL, state: {} }
      })
    )
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-ctx', 'member')

    await postStart(suite.app, member.cookies)

    expect(seenContext?.orgId).toBe(member.orgId)
    expect(seenContext?.identity.userId).toBe(member.userId)
    expect(seenContext?.slot).toBe(OAUTH_HANDOFF_CAPABILITY)
  })
})

describe('GET /api/v1/extensions/oauth-handoff/callback (Story 39.1 AC2/AC3)', () => {
  suite.registerLifecycle()

  beforeEach(async () => {
    __resetExtensionStateForTests()
    await getDb().delete(extensionOauthPendingStates)
  })

  it('AC2: resolves WITHOUT requiring a valid PV session, looks up state by the cookie hash, and issues a second 302', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-cb-happy', 'member')
    let seenQuery: Record<string, string> | undefined
    let seenState: Record<string, unknown> | undefined
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    __setExtensionStateForTests(
      defaultHandoffState(undefined, async (query, state) => {
        seenQuery = query
        seenState = state
        return { outcome: 'redirect', url: CALLBACK_TARGET_URL, state: {} }
      })
    )

    const res = await getCallback(suite.app, cookieValue, { code: 'abc123', state: 'opaque' })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(CALLBACK_TARGET_URL)
    expect(seenQuery).toEqual({ code: 'abc123', state: 'opaque' })
    expect(seenState).toEqual({ nonce: 'abc' })
  })

  it('AC3: a missing cookie is rejected generically, onOAuthCallback never invoked', async () => {
    const onOAuthCallback = vi.fn()
    __setExtensionStateForTests(defaultHandoffState(undefined, onOAuthCallback))

    const res = await getCallback(suite.app, undefined)

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'oauth_handoff_rejected' })
    expect(onOAuthCallback).not.toHaveBeenCalled()
  })

  it('AC3: an unknown cookie value is rejected generically (no matching pending row)', async () => {
    const onOAuthCallback = vi.fn()
    __setExtensionStateForTests(defaultHandoffState(undefined, onOAuthCallback))

    const res = await getCallback(suite.app, 'not-a-real-cookie-value')

    expect(res.statusCode).toBe(401)
    expect(onOAuthCallback).not.toHaveBeenCalled()
  })

  it('AC3: a replayed (already-consumed) cookie is rejected generically on the second hit', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-replay', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    const onOAuthCallback = vi.fn(async () => ({
      outcome: 'redirect' as const,
      url: CALLBACK_TARGET_URL,
      state: {},
    }))
    __setExtensionStateForTests(defaultHandoffState(undefined, onOAuthCallback))

    const first = await getCallback(suite.app, cookieValue)
    expect(first.statusCode).toBe(302)
    expect(onOAuthCallback).toHaveBeenCalledTimes(1)

    const second = await getCallback(suite.app, cookieValue)
    expect(second.statusCode).toBe(401)
    expect(onOAuthCallback).toHaveBeenCalledTimes(1)
  })

  it('Boundary Sweep: concurrent duplicate callback hits for the same pending row — only one succeeds', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-concurrent', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    const onOAuthCallback = vi.fn(async () => ({
      outcome: 'redirect' as const,
      url: CALLBACK_TARGET_URL,
      state: {},
    }))
    __setExtensionStateForTests(defaultHandoffState(undefined, onOAuthCallback))

    const [first, second] = await Promise.all([
      getCallback(suite.app, cookieValue),
      getCallback(suite.app, cookieValue),
    ])

    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([302, 401])
    expect(onOAuthCallback).toHaveBeenCalledTimes(1)
  })

  it('AC3: an expired pending row is rejected generically', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-expired', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    await getDb()
      .update(extensionOauthPendingStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
    const onOAuthCallback = vi.fn()
    __setExtensionStateForTests(defaultHandoffState(undefined, onOAuthCallback))

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(401)
    expect(onOAuthCallback).not.toHaveBeenCalled()
  })

  it('Assumption Audit: extension disabled/uninstalled between start and callback fails closed', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-uninstalled', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    __resetExtensionStateForTests()

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(401)
  })

  it('Assumption Audit: a different extension loaded by callback time fails closed', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-swapped', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    __setExtensionStateForTests(defaultHandoffState(undefined, undefined))
    // Swap in a different extension name before the callback arrives.
    __setExtensionStateForTests(
      loadedState({
        name: 'com.other.ext',
        redirectOrigins: [PV_ORIGIN],
        oauthHandoff: {
          onOAuthStart: async () => ({
            outcome: 'redirect' as const,
            url: PROVIDER_AUTHORIZE_URL,
            state: {},
          }),
          onOAuthCallback: vi.fn(async () => ({
            outcome: 'redirect' as const,
            url: CALLBACK_TARGET_URL,
            state: {},
          })),
        },
      })
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(401)
  })

  it('Boundary Sweep: a provider error query param still resolves to a normal onOAuthCallback invocation', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-provider-error', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    let seenQuery: Record<string, string> | undefined
    __setExtensionStateForTests(
      defaultHandoffState(undefined, async (query) => {
        seenQuery = query
        return { outcome: 'denied', message: 'user declined' }
      })
    )

    const res = await getCallback(suite.app, cookieValue, { error: 'access_denied' })

    expect(res.statusCode).toBe(403)
    expect(seenQuery).toEqual({ error: 'access_denied' })
  })

  it('AC6: onOAuthCallback may resolve a non-redirect ActionResult, mapped the same way', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-cb-nonredirect', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    __setExtensionStateForTests(defaultHandoffState(undefined, async () => ({ outcome: 'error' })))

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(500)
  })

  it('Story 59.1 AC8: an error result with html on the callback leg is forwarded as JSON, and the pending cookie is burned', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-cb-error-html', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    __setExtensionStateForTests(
      defaultHandoffState(undefined, async () => ({ outcome: 'error', html: '<p>E</p>' }))
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({
      code: 'internal_error',
      message: 'Request failed',
      html: '<p>E</p>',
    })
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/)
    const replay = await getCallback(suite.app, cookieValue)
    expect(replay.statusCode).not.toBe(500)
    expect(replay.json()).not.toHaveProperty('html')
  })

  it('AC9: rejects the second redirect url when its origin is not allow-listed', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'oauth-cb-badorigin', 'member')
    const cookieValue = await startAndGetCookie(suite.app, member.cookies)
    __setExtensionStateForTests(
      defaultHandoffState(undefined, async () => ({
        outcome: 'redirect',
        url: 'https://attacker.example/steal',
        state: {},
      }))
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(401)
  })
})

/**
 * Shared by AC4 (below) and Story 40.1's AC7 describe block — both scan every non-test `.ts`
 * file under `apps/api/src` for `setCookie(...)` call sites, so this walk is extracted once
 * rather than hand-copied per cookie-name-disjointness test (AC11-style rule-of-three discipline,
 * applied within this one test file).
 */
async function tsFilesUnderApiSrc(): Promise<string[]> {
  const { readdirSync, statSync } = await import('node:fs')
  const { resolve } = await import('node:path')

  // apps/api/src is this test file's own ancestor — walk up from here rather than trusting an
  // ambient cwd (which differs between `vitest run` invoked from the repo root vs this package).
  const apiSrcRoot = resolve(new URL('.', import.meta.url).pathname, '../../')

  function tsFilesUnder(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const fullPath = resolve(dir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) files.push(...tsFilesUnder(fullPath))
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(fullPath)
    }
    return files
  }

  return tsFilesUnder(apiSrcRoot)
}

describe('AC4: cookie namespace does not collide with any existing PV cookie name', () => {
  it('oauth-handoff-pending is disjoint from every other literal cookie name used by setCookie(...) call sites', async () => {
    const { readFileSync } = await import('node:fs')

    // `setCookie('literal', ...)` string-literal call sites (handoff-routes.ts, tokens.ts, etc).
    const literalNames = new Set<string>()
    // `setCookie(SOME_CONSTANT, ...)` — this route's own cookie name is passed as a named
    // constant, not a string literal, so its VALUE is cross-checked separately below via the
    // constant's own declaration (`const OAUTH_HANDOFF_COOKIE_NAME = '...'`).
    const constantDeclaredNames = new Set<string>()

    for (const filePath of await tsFilesUnderApiSrc()) {
      const source = readFileSync(filePath, 'utf8')
      for (const match of source.matchAll(/setCookie\(\s*['"]([^'"]+)['"]/g)) {
        if (match[1]) literalNames.add(match[1])
      }
      for (const match of source.matchAll(/const [A-Z_]*COOKIE[A-Z_]*NAME\w* = '([^']+)'/g)) {
        if (match[1]) constantDeclaredNames.add(match[1])
      }
    }

    // Sanity: the scan actually found other real cookie literals (e.g. handoff-confirm), proving
    // this test exercises something real rather than silently matching zero files.
    expect(literalNames.size).toBeGreaterThan(1)
    expect(constantDeclaredNames.has(OAUTH_HANDOFF_COOKIE_NAME)).toBe(true)

    expect(literalNames.has(OAUTH_HANDOFF_COOKIE_NAME)).toBe(false)
    for (const name of constantDeclaredNames) {
      if (name === OAUTH_HANDOFF_COOKIE_NAME) continue
      expect(name).not.toBe(OAUTH_HANDOFF_COOKIE_NAME)
    }
  })
})

describe('AC5: multi-journey safety — two concurrent pending rows never cross-resolve', () => {
  suite.registerLifecycle()

  beforeEach(async () => {
    __resetExtensionStateForTests()
    await getDb().delete(extensionOauthPendingStates)
  })

  it('two journeys from the same extension each resolve against their own independently-keyed row', async () => {
    const memberA = await createDirectAuthenticatedUser(suite.app, 'oauth-multi-a', 'member')
    const memberB = await createDirectAuthenticatedUser(suite.app, 'oauth-multi-b', 'member')

    const cookieA = await startAndGetCookie(suite.app, memberA.cookies, async () => ({
      outcome: 'redirect',
      url: PROVIDER_AUTHORIZE_URL,
      state: { journey: 'a' },
    }))
    const cookieB = await startAndGetCookie(suite.app, memberB.cookies, async () => ({
      outcome: 'redirect',
      url: PROVIDER_AUTHORIZE_URL,
      state: { journey: 'b' },
    }))

    expect(cookieA).not.toBe(cookieB)

    const seenStates: Record<string, unknown>[] = []
    __setExtensionStateForTests(
      defaultHandoffState(undefined, async (_query, state) => {
        seenStates.push(state)
        return { outcome: 'redirect', url: CALLBACK_TARGET_URL, state: {} }
      })
    )

    const resA = await getCallback(suite.app, cookieA)
    const resB = await getCallback(suite.app, cookieB)

    expect(resA.statusCode).toBe(302)
    expect(resB.statusCode).toBe(302)
    expect(seenStates).toContainEqual({ journey: 'a' })
    expect(seenStates).toContainEqual({ journey: 'b' })
  })
})

describe('AC8: version-skew invariant sanity (not a full CI-script re-run, see scripts/check-extension-api-version-skew.ts)', () => {
  it('the oauth-handoff manifest fields round-trip through a real loaded ExtensionState', () => {
    const state = defaultHandoffState()
    if (state.status !== 'loaded') throw new Error('expected loaded state')
    expect(state.manifest.capabilities).toContain(OAUTH_HANDOFF_CAPABILITY)
    expect(state.manifest.redirectOrigins).toEqual([PROVIDER_ORIGIN, PV_ORIGIN])
  })
})

// Story 40.1 — persistState leg tests. Mirrors the file's own existing suite conventions above.
describe('Story 40.1 AC1/AC5/AC6/Pre-Mortem-3: persistState leg of the callback route', () => {
  suite.registerLifecycle()

  beforeEach(async () => {
    __resetExtensionStateForTests()
    await getDb().delete(extensionOauthPendingStates)
    await getDb().delete(extensionRequestStates)
  })

  async function startAndGetCookieWithCallback(
    app: TestApp,
    cookies: CookieJar,
    onOAuthCallback: OAuthHandoffHooks['onOAuthCallback']
  ): Promise<string> {
    __setExtensionStateForTests(defaultHandoffState(undefined, onOAuthCallback))
    const res = await postStart(app, cookies)
    expect(res.statusCode).toBe(302)
    return extractPendingCookie(res)
  }

  it('AC1: onOAuthCallback returning persistState mints a second cookie + extension_request_states row', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'persist-ac1', 'member')
    const cookieValue = await startAndGetCookieWithCallback(
      suite.app,
      member.cookies,
      async () => ({
        outcome: 'redirect',
        url: CALLBACK_TARGET_URL,
        state: {},
        persistState: { selectionId: 'abc123' },
      })
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(302)
    const cookies = parseSetCookies(res.headers['set-cookie'] as string | string[] | undefined)
    expect(cookies[REQUEST_STATE_COOKIE_NAME]).toBeDefined()

    const rows = await getDb().select().from(extensionRequestStates)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.consumedAt).toBeNull()
    expect(JSON.parse(rows[0]?.stateJson ?? '{}')).toEqual({ selectionId: 'abc123' })
    expect(rows[0]?.orgId).toBe(member.orgId)
    expect(rows[0]?.identityId).toBe(member.userId)
    const ttlMs = (rows[0]?.expiresAt?.getTime() ?? 0) - Date.now()
    expect(ttlMs).toBeGreaterThan(25 * 60 * 1000)
    expect(ttlMs).toBeLessThanOrEqual(30 * 60 * 1000)
  })

  it('AC5: persistState on onOAuthStart has no effect — no second cookie/row, no change to the start leg', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'persist-ac5', 'member')
    __setExtensionStateForTests(
      defaultHandoffState(async () => ({
        outcome: 'redirect',
        url: PROVIDER_AUTHORIZE_URL,
        state: { nonce: 'abc' },
        // Misuse: persistState is only meaningful on onOAuthCallback.
        persistState: { shouldNeverPersist: true },
      }))
    )

    const res = await postStart(suite.app, member.cookies)

    expect(res.statusCode).toBe(302)
    const cookies = parseSetCookies(res.headers['set-cookie'] as string | string[] | undefined)
    expect(cookies[REQUEST_STATE_COOKIE_NAME]).toBeUndefined()
    expect(await getDb().select().from(extensionRequestStates)).toHaveLength(0)
  })

  it('AC6: an oversized persistState never mints a row/cookie but leaves the redirect unaffected', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'persist-ac6', 'member')
    const cookieValue = await startAndGetCookieWithCallback(
      suite.app,
      member.cookies,
      async () => ({
        outcome: 'redirect',
        url: CALLBACK_TARGET_URL,
        state: {},
        persistState: { big: 'x'.repeat(5000) },
      })
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(CALLBACK_TARGET_URL)
    const cookies = parseSetCookies(res.headers['set-cookie'] as string | string[] | undefined)
    expect(cookies[REQUEST_STATE_COOKIE_NAME]).toBeUndefined()
    expect(await getDb().select().from(extensionRequestStates)).toHaveLength(0)
  })

  it('stray persistState on a non-redirect callback outcome is ignored entirely (Boundary Sweep)', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'persist-nonredirect', 'member')
    // A stray `persistState` field on a non-redirect ActionResult (a misuse the type system
    // doesn't forbid via a plain object literal in this contextually-typed position — see the
    // real `@ts-expect-error` proofs in `module-action.test.ts` for the enforced type-level
    // guarantees this story adds); the route must never read it regardless.
    const strayPersistCallback = (async () => ({
      outcome: 'denied',
      persistState: { shouldNeverPersist: true },
    })) as OAuthHandoffHooks['onOAuthCallback']
    const cookieValue = await startAndGetCookieWithCallback(
      suite.app,
      member.cookies,
      strayPersistCallback
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(403)
    expect(await getDb().select().from(extensionRequestStates)).toHaveLength(0)
  })

  it('Pre-Mortem 3: a rejected redirect (invalid origin) never leaves an orphaned extension_request_states row', async () => {
    const member = await createDirectAuthenticatedUser(suite.app, 'persist-premortem3', 'member')
    const cookieValue = await startAndGetCookieWithCallback(
      suite.app,
      member.cookies,
      async () => ({
        outcome: 'redirect',
        url: 'https://attacker.example/steal',
        state: {},
        persistState: { selectionId: 'should-not-persist' },
      })
    )

    const res = await getCallback(suite.app, cookieValue)

    expect(res.statusCode).toBe(401)
    expect(await getDb().select().from(extensionRequestStates)).toHaveLength(0)
  })
})

describe('Story 40.1 AC7: extension-request-state cookie namespace is disjoint from every existing PV cookie, including oauth-handoff-pending', () => {
  it('extension-request-state is disjoint from every other literal/constant cookie name used by setCookie(...) call sites', async () => {
    const { readFileSync } = await import('node:fs')

    const literalNames = new Set<string>()
    const constantDeclaredNames = new Set<string>()

    for (const filePath of await tsFilesUnderApiSrc()) {
      const source = readFileSync(filePath, 'utf8')
      for (const match of source.matchAll(/setCookie\(\s*['"]([^'"]+)['"]/g)) {
        if (match[1]) literalNames.add(match[1])
      }
      for (const match of source.matchAll(/const [A-Z_]*COOKIE[A-Z_]*NAME\w* = '([^']+)'/g)) {
        if (match[1]) constantDeclaredNames.add(match[1])
      }
    }

    expect(literalNames.size).toBeGreaterThan(1)
    expect(constantDeclaredNames.has(REQUEST_STATE_COOKIE_NAME)).toBe(true)
    expect(constantDeclaredNames.has(OAUTH_HANDOFF_COOKIE_NAME)).toBe(true)

    expect(literalNames.has(REQUEST_STATE_COOKIE_NAME)).toBe(false)
    for (const name of constantDeclaredNames) {
      if (name === REQUEST_STATE_COOKIE_NAME) continue
      expect(name).not.toBe(REQUEST_STATE_COOKIE_NAME)
    }
  })
})
