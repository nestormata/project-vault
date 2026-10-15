// Story 68-27 — auth resolution in PV's own `handle`: the request budget (a structural count of
// `/auth/me` calls, never a wall-clock assertion), the proxy-route skip keyed on the Kit route id,
// the retryable refusal when the auth API throttles or fails, and per-request isolation. The real
// `resolveAuthContext` runs against a counting fake of the internal API fetch.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeKitRequest } from './kit-request-test-helpers.js'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const internalApiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({ getVaultReadiness: getVaultReadinessMock }))
vi.mock('$lib/server/internal-api-tls.js', () => ({ internalApiFetch: internalApiFetchMock }))

import { createPvHandle } from './pv-server-hooks.js'
import {
  EMPTY_CONTRIBUTED_PATHS,
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
} from '../protected-paths.js'

const handle = createPvHandle({
  apiBaseUrl: () => 'http://api.test',
  protectedPaths: composeProtectedPaths(PV_PROTECTED_PREFIXES, EMPTY_CONTRIBUTED_PATHS),
})

const PROXY_ROUTE = '/api/v1/[...path]'
const PROJECT_ROUTE = '/(app)/projects/[projectId]'

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function authMeCalls() {
  return internalApiFetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/me'))
}

function userFor(cookie: string | null) {
  const id = cookie?.match(/access-token=(\w+)/)?.[1]
  return id ? { id, orgRole: 'member' } : null
}

async function run(
  path: string,
  routeId: string | null,
  options: { cookie?: string | null; method?: string; accept?: string } = {}
) {
  const req = fakeKitRequest(path, {
    routeId,
    cookie: options.cookie === undefined ? 'access-token=u1' : options.cookie,
    method: options.method,
  })
  if (options.accept) req.event.request.headers.set('accept', options.accept)
  const response = await handle({ event: req.event, resolve: req.resolve } as never)
  return { req, response }
}

beforeEach(() => {
  getVaultReadinessMock.mockReset()
  getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
  internalApiFetchMock.mockReset()
  internalApiFetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    return json(
      { data: userFor(headers.get('cookie')) },
      userFor(headers.get('cookie')) ? {} : { status: 401 }
    )
  })
})

describe('request budget (AC-1)', () => {
  it('resolves auth once for the outer page request and zero times for N internal API fetches', async () => {
    const internalApiRequests = 5
    await run('/projects/p1', PROJECT_ROUTE)
    // SvelteKit runs a server load's `event.fetch('/api/v1/...')` through `handle` again.
    const internal = await Promise.all(
      Array.from({ length: internalApiRequests }, (_, i) =>
        run(`/api/v1/projects/p1/part-${i}`, PROXY_ROUTE)
      )
    )
    internal.forEach(({ req }, i) => {
      expect(req.resolvedPathnames).toEqual([`/api/v1/projects/p1/part-${i}`])
    })
    expect(authMeCalls()).toHaveLength(1)
  })

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'skips the probe for %s on the proxy route and the handoff prepare route',
    async (method) => {
      await run('/api/v1/projects', PROXY_ROUTE, { method })
      await run('/api/v1/auth/handoff/prepare', '/api/v1/auth/handoff/prepare', { method })
      expect(authMeCalls()).toHaveLength(0)
    }
  )

  it('leaves locals.user null on a skipped route, even if a contributed before-handle set it', async () => {
    const req = fakeKitRequest('/api/v1/projects', {
      routeId: PROXY_ROUTE,
      cookie: 'access-token=u1',
    })
    req.event.locals.user = { id: 'spoofed', orgRole: 'owner' }
    await handle({ event: req.event, resolve: req.resolve } as never)
    expect(req.event.locals.user).toBeNull()
  })

  it.each([
    ['a contributed +server route under /api/v1', '/api/v1/billing', '/api/v1/billing'],
    ['no route matched', '/api/v1/projects', null],
    ['a rerouted native page', '/api/v1/projects', '/(app)/dashboard'],
    ['a lookalike route id', '/api/v1/projects', '/api/v1/[...path]/extra'],
    ['a percent-encoded protected page', '/%64ashboard', '/(app)/dashboard'],
  ])('does NOT skip the probe for %s', async (_label, path, routeId) => {
    await run(path, routeId)
    expect(authMeCalls()).toHaveLength(1)
  })

  it('still redirects an anonymous protected page request to /login (spoof-proof)', async () => {
    const { response } = await run('/dashboard', '/(app)/dashboard', { cookie: null })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
  })
})

describe('upstream auth failure is retryable, never a sign-out (AC-2)', () => {
  function authMeReturns(response: () => Response | Promise<Response>) {
    internalApiFetchMock.mockImplementation(async () => response())
  }

  it('answers a protected page request 429 + sanitized Retry-After when /auth/me is throttled', async () => {
    authMeReturns(() =>
      json(
        { code: 'rate_limited', secret: 'leak' },
        { status: 429, headers: { 'retry-after': '12', 'x-internal': 'leak' } }
      )
    )
    const { response, req } = await run('/dashboard', '/(app)/dashboard')

    expect(response.status).toBe(429)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('retry-after')).toBe('12')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-internal')).toBeNull()
    expect(await response.json()).toEqual({
      code: 'auth_unavailable',
      message: 'Authentication is temporarily unavailable. Please retry.',
    })
    expect(req.resolvedPathnames).toEqual([])
    expect(req.event.locals.user).toBeNull()
  })

  it.each([
    ['500', () => json({}, { status: 500 })],
    ['503', () => json({}, { status: 503 })],
    ['transport failure', () => Promise.reject(new Error('ECONNRESET'))],
  ])('answers 503 for %s, with no redirect and no reason', async (_label, produce) => {
    authMeReturns(produce)
    const { response } = await run('/projects/p1', PROJECT_ROUTE)
    expect(response.status).toBe(503)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.has('retry-after')).toBe(false)
  })

  it('serves a fixed HTML page to a browser navigation and never reflects the request', async () => {
    authMeReturns(() => json({}, { status: 429 }))
    const { response } = await run('/projects/p1?x=<script>', PROJECT_ROUTE, {
      accept: 'text/html,*/*',
    })
    const body = await response.text()
    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('Temporarily unavailable')
    expect(body).not.toContain('script')
  })

  it('renders an unprotected page as anonymous instead of refusing it', async () => {
    authMeReturns(() => json({}, { status: 429 }))
    const { response, req } = await run('/login', '/(auth)/login')
    expect(response.status).toBe(200)
    expect(req.resolvedPathnames).toEqual(['/login'])
    expect(req.event.locals.user).toBeNull()
  })

  it('keeps the rotated refresh cookie on the refusal when the retry is throttled', async () => {
    internalApiFetchMock
      .mockResolvedValueOnce(json({}, { status: 401 }))
      .mockResolvedValueOnce(
        json({ data: {} }, { headers: { 'set-cookie': 'refresh-token=rotated; Path=/' } })
      )
      .mockResolvedValueOnce(json({}, { status: 429 }))
    const { response } = await run('/dashboard', '/(app)/dashboard', {
      cookie: 'refresh-token=old',
    })
    expect(response.status).toBe(429)
    expect(response.headers.getSetCookie()).toEqual(['refresh-token=rotated; Path=/'])
  })

  it('still redirects to /login with the session-expired reason on a genuine rejected refresh', async () => {
    internalApiFetchMock
      .mockResolvedValueOnce(json({}, { status: 401 }))
      .mockResolvedValueOnce(json({}, { status: 401 }))
    const { response } = await run('/dashboard', '/(app)/dashboard', {
      cookie: 'refresh-token=old',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login?reason=session-expired')
  })
})

describe('isolation (AC-3)', () => {
  it('keeps concurrent requests with different cookies on their own users', async () => {
    const runs = await Promise.all(
      ['u1', 'u2', 'u3', 'u4'].map((id) =>
        run('/dashboard', '/(app)/dashboard', { cookie: `access-token=${id}` })
      )
    )
    expect(runs.map(({ req }) => req.event.locals.user)).toEqual([
      { id: 'u1', orgRole: 'member' },
      { id: 'u2', orgRole: 'member' },
      { id: 'u3', orgRole: 'member' },
      { id: 'u4', orgRole: 'member' },
    ])
  })

  it('never reuses an auth result across requests (no cache)', async () => {
    await run('/dashboard', '/(app)/dashboard')
    await run('/dashboard', '/(app)/dashboard')
    expect(authMeCalls()).toHaveLength(2)
  })

  it('forwards each request cookie to its own /auth/me probe only', async () => {
    await run('/dashboard', '/(app)/dashboard', { cookie: 'access-token=u1' })
    await run('/dashboard', '/(app)/dashboard', { cookie: 'access-token=u2' })
    const cookies = authMeCalls().map(([, init]) => new Headers(init?.headers).get('cookie'))
    expect(cookies).toEqual(['access-token=u1', 'access-token=u2'])
  })
})
