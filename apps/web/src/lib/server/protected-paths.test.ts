// Story 68.6 AC-7 — protected paths as data; one gate function; the reroute bypass is closed.
import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONTRIBUTED_PATHS,
  PV_PROTECTED_PREFIXES,
  composeProtectedPaths,
  isProtectedRequest,
} from './protected-paths.js'
import { isProtectedAppPath } from './auth-guard.js'
import { stripRouteGroups } from '$lib/composition/route-id.js'

const PV = composeProtectedPaths(PV_PROTECTED_PREFIXES, EMPTY_CONTRIBUTED_PATHS)
const req = (pathname: string, routeId: string | null = null) => ({ pathname, routeId })

describe('PV_PROTECTED_PREFIXES', () => {
  it('is the 9-entry list from auth-guard, same order, /extensions/panels verbatim', () => {
    expect(PV_PROTECTED_PREFIXES).toEqual([
      '/dashboard',
      '/projects',
      '/credentials',
      '/alerts',
      '/health',
      '/settings',
      '/platform',
      '/notifications',
      '/extensions/panels',
    ])
    expect(Object.isFrozen(PV_PROTECTED_PREFIXES)).toBe(true)
  })

  it('isProtectedAppPath delegates and keeps its segment-prefix behaviour', () => {
    expect(isProtectedAppPath('/dashboard')).toBe(true)
    expect(isProtectedAppPath('/dashboard/x')).toBe(true)
    expect(isProtectedAppPath('/dashboardx')).toBe(false)
    expect(isProtectedAppPath('/shares/tok')).toBe(false)
  })
})

describe('isProtectedRequest (AC-7)', () => {
  const cases: Array<[string, string | null, boolean]> = [
    ['/dashboard', '/(app)/dashboard', true],
    ['/dashboard/', null, true],
    ['/dashboard/nope', null, true],
    ['/dashboardx', null, false],
    ['/Dashboard', null, false],
    ['/status/tok', '/status/[token]', false],
    ['/handoff', '/(auth)/handoff', false],
    ['/shares/tok', '/(app)/shares/[token]', false],
    // Q5: reroute bypass closed.
    ['/r/dash', '/(app)/dashboard', true],
    ['/r/dash', '/status/[token]', false],
    // Percent-encoded URL: Kit matched the decoded route.
    ['/%73ettings/notifications', '/(app)/settings/notifications', true],
    // Rest/optional params.
    ['/x', '/(app)/projects/[projectId]/[[tab]]', true],
    // Q9: remote functions are not gated by protected paths (pinned).
    ['/_app/remote/abc', null, false],
  ]
  for (const [pathname, routeId, expected] of cases) {
    it(`${pathname} (route ${String(routeId)}) -> ${String(expected)}`, () => {
      expect(isProtectedRequest(PV, req(pathname, routeId))).toBe(expected)
    })
  }

  it('a derived route id is protected exactly, not as a prefix', () => {
    const paths = composeProtectedPaths(PV_PROTECTED_PREFIXES, {
      routeIds: ['/(app)/cm-area'],
      add: [],
      remove: [],
    })
    expect(isProtectedRequest(paths, req('/cm-area', '/(app)/cm-area'))).toBe(true)
    expect(isProtectedRequest(paths, req('/cm-area/x', '/(app)/cm-area/x'))).toBe(false)
    expect(isProtectedRequest(paths, req('/cm-area', null))).toBe(false)
  })
})

describe('composeProtectedPaths (AC-8 runtime side)', () => {
  it('prefixes = PV ∪ add − remove; routeIds = derived − remove', () => {
    const paths = composeProtectedPaths(PV_PROTECTED_PREFIXES, {
      routeIds: ['/(app)/cm-area', '/(app)/cm-area/callback'],
      add: ['/public-cm'],
      remove: ['/health', '/(app)/cm-area/callback'],
    })
    expect(paths.prefixes).toContain('/public-cm')
    expect(paths.prefixes).not.toContain('/health')
    expect([...paths.routeIds]).toEqual(['/(app)/cm-area'])
    expect(isProtectedRequest(paths, req('/public-cm/x'))).toBe(true)
    expect(isProtectedRequest(paths, req('/cm-area/callback', '/(app)/cm-area/callback'))).toBe(
      false
    )
  })

  it('may remove every PV prefix (anti-allowlist)', () => {
    const paths = composeProtectedPaths(PV_PROTECTED_PREFIXES, {
      routeIds: [],
      add: [],
      remove: [...PV_PROTECTED_PREFIXES],
    })
    expect(paths.prefixes).toEqual([])
    expect(isProtectedRequest(paths, req('/dashboard', '/(app)/dashboard'))).toBe(false)
  })

  it('fails when an effective prefix covers a guard redirect target (Q8 redirect loop)', () => {
    expect(() =>
      composeProtectedPaths(PV_PROTECTED_PREFIXES, { routeIds: [], add: ['/login'], remove: [] })
    ).toThrow('protected prefix "/login" covers the guard redirect target /login (redirect loop)')
    expect(() =>
      composeProtectedPaths(PV_PROTECTED_PREFIXES, {
        routeIds: ['/(app)/vault'],
        add: [],
        remove: [],
      })
    ).toThrow(
      'protected route "/(app)/vault" covers the guard redirect target /vault (redirect loop)'
    )
  })

  it('is deep-frozen', () => {
    expect(Object.isFrozen(PV.prefixes)).toBe(true)
  })
})

describe('stripRouteGroups', () => {
  it('removes (group) segments with a linear split', () => {
    expect(stripRouteGroups('/(app)/(nested)/reports/[id]')).toBe('/reports/[id]')
    expect(stripRouteGroups('/(app)')).toBe('/')
    expect(stripRouteGroups('/')).toBe('/')
    expect(stripRouteGroups('/status/[token]')).toBe('/status/[token]')
  })

  it('handles a very long input (no regex, so no backtracking)', () => {
    expect(stripRouteGroups(`/${'(g)/'.repeat(50_000)}x`)).toBe('/x')
    expect(stripRouteGroups(`/${'((('.repeat(50_000)}`)).toBe(`/${'((('.repeat(50_000)}`)
  })
})
