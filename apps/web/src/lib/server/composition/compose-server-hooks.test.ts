// Story 68.6 AC-2/AC-4/AC-7/AC-14 — PV's handle inside the composed chain: Q10 placement of
// `before`/`after`/`wrap`, the gate cannot be spoofed, errors propagate, no cross-talk between
// concurrent requests, and Paraglide's locale is isolated per request.
import type { Handle } from '@sveltejs/kit'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { getLocale } from '$lib/paraglide/runtime.js'
import { PV_HEADER_POLICY } from '$lib/security/header-policy.js'
import {
  EMPTY_CONTRIBUTED_PATHS,
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
} from '$lib/server/protected-paths.js'
import { composeServerHooks } from './compose-server-hooks.js'
import { createPvHandle } from './pv-server-hooks.js'
import { describeResponse, fakeKitRequest } from './kit-request-test-helpers.js'

const getVaultReadinessMock = vi.hoisted(() => vi.fn())
const resolveAuthContextMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/vault.js', () => ({ getVaultReadiness: getVaultReadinessMock }))
vi.mock('$lib/server/auth-guard.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/auth-guard.js')>(
    '$lib/server/auth-guard.js'
  )
  return { ...actual, resolveAuthContext: resolveAuthContextMock }
})

function pvHandle(contributedPaths = EMPTY_CONTRIBUTED_PATHS) {
  return createPvHandle({
    apiBaseUrl: () => 'http://api.test',
    protectedPaths: composeProtectedPaths(PV_PROTECTED_PREFIXES, contributedPaths),
  })
}

function compose(contributed: Record<string, unknown>, paths = EMPTY_CONTRIBUTED_PATHS) {
  return composeServerHooks({ handle: pvHandle(paths) }, contributed, {
    headerPolicy: PV_HEADER_POLICY,
  })
}

function authenticatedFor(cookieUser: (cookie: string | null) => string | null) {
  resolveAuthContextMock.mockImplementation(
    async ({ cookieHeader }: { cookieHeader: string | null }) => {
      const user = cookieUser(cookieHeader)
      return user ? { status: 'authenticated', user: { id: user } } : { status: 'unauthenticated' }
    }
  )
}

beforeEach(() => {
  getVaultReadinessMock.mockReset()
  getVaultReadinessMock.mockResolvedValue({ state: 'ready' })
  resolveAuthContextMock.mockReset()
  resolveAuthContextMock.mockResolvedValue({ status: 'unauthenticated' })
})

describe('no contribution: Kit defaults preserved (AC-2, AC-3, Q7)', () => {
  it('every hook PV does not define stays undefined; handle is a function', () => {
    const hooks = compose({})
    expect(typeof hooks.handle).toBe('function')
    expect(hooks.handleFetch).toBeUndefined()
    expect(hooks.handleError).toBeUndefined()
    expect(hooks.handleValidationError).toBeUndefined()
    expect(hooks.init).toBeUndefined()
    expect(hooks.headerPolicy).toBe(PV_HEADER_POLICY)
  })

  it('non-hook exports are ignored (Q11)', () => {
    expect(() => compose({ hookLabel: 'mini-pack', helper: () => 1 })).not.toThrow()
  })
})

describe('Q10 placement: before outermost, after inside PV right before resolve', () => {
  it('before runs for an anonymous protected request; after only for allowed requests', async () => {
    const log: string[] = []
    const hooks = compose({
      handle: {
        before: [
          (({ event, resolve }) => {
            log.push(`before:${event.url.pathname}:${String(event.locals.user)}`)
            return resolve(event)
          }) satisfies Handle,
        ],
        after: [
          (({ event, resolve }) => {
            log.push(
              `after:${event.url.pathname}:${String((event.locals.user as { id?: string })?.id)}:${getLocale()}`
            )
            return resolve(event)
          }) satisfies Handle,
        ],
      },
    })
    const anon = fakeKitRequest('/settings', { routeId: '/(app)/settings' })
    const redirected = await hooks.handle({ event: anon.event, resolve: anon.resolve } as never)
    expect(redirected.status).toBe(303)

    authenticatedFor((cookie) => (cookie?.includes('session') ? 'u1' : null))
    const authed = fakeKitRequest('/settings', {
      routeId: '/(app)/settings',
      cookie: 'session=1; PARAGLIDE_LOCALE=es',
    })
    const ok = await hooks.handle({ event: authed.event, resolve: authed.resolve } as never)
    expect(ok.status).toBe(200)
    expect(log).toEqual([
      'before:/settings:undefined',
      'before:/settings:undefined',
      'after:/settings:u1:es',
    ])
  })

  it('wrap replaces PV handle in place, between before and after', async () => {
    const log: string[] = []
    const hooks = compose({
      handle: {
        before: [(({ event, resolve }) => (log.push('before'), resolve(event))) satisfies Handle],
        wrap:
          (pv: Handle): Handle =>
          async (input) => {
            log.push('wrap:pre')
            const response = await pv(input)
            log.push('wrap:post')
            return response
          },
        after: [(({ event, resolve }) => (log.push('after'), resolve(event))) satisfies Handle],
      },
    })
    const req = fakeKitRequest('/status/tok', { routeId: '/status/[token]' })
    await hooks.handle({ event: req.event, resolve: req.resolve } as never)
    expect(log).toEqual(['before', 'wrap:pre', 'after', 'wrap:post'])
  })

  // Code review 68-6: an `after` handle may return a Response whose headers are immutable
  // (`Response.redirect()`, a proxied `fetch()`); forwarding refreshed cookies onto it must not
  // throw (it used to be a 500 exactly when a token refresh happened).
  for (const [label, make] of [
    ['Response.redirect()', async () => Response.redirect('http://pv.test/elsewhere', 302)],
    ['a fetch-proxied response', async () => fetch('data:text/plain,proxied')],
  ] as const) {
    it(`refreshed cookies are forwarded onto ${label} from an after handle`, async () => {
      const upstream = await make()
      expect(() => upstream.headers.append('x-probe', '1')).toThrow(TypeError)
      resolveAuthContextMock.mockImplementation(
        async ({ forwardSetCookie }: { forwardSetCookie: (value: string) => void }) => {
          forwardSetCookie('access-token=renewed; Path=/; HttpOnly')
          return { status: 'authenticated', user: { id: 'u1' } }
        }
      )
      const response = await make()
      const hooks = compose({ handle: { after: [(() => response) satisfies Handle] } })
      const req = fakeKitRequest('/settings', { routeId: '/(app)/settings', cookie: 'r=1' })
      const out = await hooks.handle({ event: req.event, resolve: req.resolve } as never)
      expect(out.status).toBe(response.status)
      expect(out.headers.get('location')).toBe(response.headers.get('location'))
      expect(out.headers.get('content-type')).toBe(response.headers.get('content-type'))
      expect(out.headers.getSetCookie()).toEqual(['access-token=renewed; Path=/; HttpOnly'])
      expect(await out.text()).toBe(label === 'Response.redirect()' ? '' : 'proxied')
    })
  }

  it('a function contribution is one before entry', async () => {
    const seen = vi.fn(({ event, resolve }: Parameters<Handle>[0]) => resolve(event))
    const hooks = compose({ handle: seen })
    const req = fakeKitRequest('/status/tok')
    await hooks.handle({ event: req.event, resolve: req.resolve } as never)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(req.resolvedPathnames).toEqual(['/status/tok'])
  })

  it('a wrap that does not return a function fails at module init', () => {
    expect(() => compose({ handle: { wrap: () => 'x' } })).toThrow(
      'hooks.server: wrap for "handle" must return a function (got string)'
    )
  })
})

describe('the gate (AC-7)', () => {
  it('a before handle that spoofs locals.user cannot satisfy the gate', async () => {
    const hooks = compose({
      handle: (({ event, resolve }) => {
        event.locals.user = { id: 'fake-admin', role: 'platform_operator' } as never
        return resolve(event)
      }) satisfies Handle,
    })
    const req = fakeKitRequest('/settings', { routeId: '/(app)/settings' })
    const response = await hooks.handle({ event: req.event, resolve: req.resolve } as never)
    expect(describeResponse(response)).toMatchObject({ status: 303, location: '/login' })
    expect(req.event.locals.user).toBeNull()
  })

  it('derived CM (app) route ids are gated; remove makes one route public at the hook', async () => {
    const hooks = compose(
      {},
      {
        routeIds: ['/(app)/cm-area', '/(app)/cm-area/callback'],
        add: [],
        remove: ['/(app)/cm-area/callback'],
      }
    )
    const area = fakeKitRequest('/cm-area', { routeId: '/(app)/cm-area', method: 'POST' })
    expect((await hooks.handle({ event: area.event, resolve: area.resolve } as never)).status).toBe(
      303
    )
    expect(area.resolvedPathnames).toEqual([])
    const callback = fakeKitRequest('/cm-area/callback', { routeId: '/(app)/cm-area/callback' })
    expect(
      (await hooks.handle({ event: callback.event, resolve: callback.resolve } as never)).status
    ).toBe(200)
  })

  it('reroute bypass closed: an unprotected URL rerouted onto a protected route redirects', async () => {
    const hooks = compose({})
    const req = fakeKitRequest('/go/settings', { routeId: '/(app)/settings', method: 'POST' })
    const response = await hooks.handle({ event: req.event, resolve: req.resolve } as never)
    expect(response.headers.get('location')).toBe('/login')
    expect(req.resolvedPathnames).toEqual([])
  })
})

describe('errors propagate (AC-2)', () => {
  it('a throwing before handle rejects the composed handle with the same error', async () => {
    const boom = new Error('cm before failed')
    const hooks = compose({
      handle: () => {
        throw boom
      },
    })
    const req = fakeKitRequest('/status/tok')
    await expect(hooks.handle({ event: req.event, resolve: req.resolve } as never)).rejects.toBe(
      boom
    )
  })
})

describe('header policy contribution reaches responses (AC-6)', () => {
  it('a CM rule adds a header on its route only; one setHeaders call', async () => {
    const hooks = compose({
      headerPolicy: (pv: typeof PV_HEADER_POLICY) => ({
        ...pv,
        rules: [
          ...pv.rules,
          {
            id: 'cm-billing',
            match: { routeId: '/(app)/cm-area' },
            headers: { ...pv.defaults, 'permissions-policy': 'payment=(self)' },
          },
        ],
      }),
    })
    authenticatedFor(() => 'u1')
    const cm = fakeKitRequest('/cm-area', { routeId: '/(app)/cm-area' })
    const response = await hooks.handle({ event: cm.event, resolve: cm.resolve } as never)
    expect(response.headers.get('permissions-policy')).toBe('payment=(self)')
    expect(cm.setHeadersCalls).toHaveLength(1)
    const pvPage = fakeKitRequest('/dashboard', { routeId: '/(app)/dashboard' })
    const pvResponse = await hooks.handle({ event: pvPage.event, resolve: pvPage.resolve } as never)
    expect(pvResponse.headers.get('permissions-policy')).toBeNull()
  })

  it('a CM route with no CM rule gets byte-identical headers to a PV route with no rule', async () => {
    const hooks = compose({})
    const cm = fakeKitRequest('/cm-page', { routeId: '/(cm)/cm-page' })
    const pv = fakeKitRequest('/status/tok', { routeId: '/status/[token]' })
    const a = await hooks.handle({ event: cm.event, resolve: cm.resolve } as never)
    const b = await hooks.handle({ event: pv.event, resolve: pv.resolve } as never)
    expect(describeResponse(a).headers).toEqual(describeResponse(b).headers)
  })
})

describe('concurrency and isolation (AC-14)', () => {
  it('50 rounds of interleaved requests: own headers, locals.user and cookies, zero cross-talk', async () => {
    const hooks = compose({})
    resolveAuthContextMock.mockImplementation(
      async ({
        cookieHeader,
        forwardSetCookie,
      }: {
        cookieHeader: string | null
        forwardSetCookie: (v: string) => void
      }) => {
        if (!cookieHeader) return { status: 'unauthenticated' }
        forwardSetCookie(`access-token=${cookieHeader}; Path=/`)
        return { status: 'authenticated', user: { id: cookieHeader } }
      }
    )
    for (let round = 0; round < 50; round++) {
      const delays = [Math.floor(Math.random() * 5), Math.floor(Math.random() * 5)]
      const a = fakeKitRequest('/handoff', {
        routeId: '/(auth)/handoff',
        resolveDelayMs: 5 + (delays[0] ?? 0),
      })
      const b = fakeKitRequest('/dashboard', {
        routeId: '/(app)/dashboard',
        cookie: `user-${round}`,
        resolveDelayMs: delays[1] ?? 0,
      })
      const [ra, rb] = await Promise.all([
        hooks.handle({ event: a.event, resolve: a.resolve } as never),
        hooks.handle({ event: b.event, resolve: b.resolve } as never),
      ])
      expect(ra.headers.get('referrer-policy')).toBe('strict-origin')
      expect(rb.headers.get('referrer-policy')).toBeNull()
      expect(a.event.locals.user).toBeNull()
      expect(b.event.locals.user).toEqual({ id: `user-${round}` })
      expect(ra.headers.getSetCookie()).toEqual([])
      expect(rb.headers.getSetCookie()).toEqual([`access-token=user-${round}; Path=/`])
    }
  })

  it('an after handle reads its own request locale under concurrency', async () => {
    const seen: string[] = []
    const hooks = compose({
      handle: {
        after: [
          (async ({ event, resolve }) => {
            await new Promise((r) => setTimeout(r, event.url.pathname === '/status/en' ? 10 : 1))
            seen.push(`${event.url.pathname}:${getLocale()}`)
            return resolve(event)
          }) satisfies Handle,
        ],
      },
    })
    const en = fakeKitRequest('/status/en', { cookie: 'PARAGLIDE_LOCALE=en' })
    const es = fakeKitRequest('/status/es', { cookie: 'PARAGLIDE_LOCALE=es' })
    await Promise.all([
      hooks.handle({ event: en.event, resolve: en.resolve } as never),
      hooks.handle({ event: es.event, resolve: es.resolve } as never),
    ])
    expect(seen.sort()).toEqual(['/status/en:en', '/status/es:es'])
  })
})
