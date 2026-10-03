/**
 * @pv-guard route-exists
 *
 * A static URL must resolve to a real `+page.svelte` in the tree under test (PV's own, or a composed
 * app root through `PV_GUARD_APP_ROOT`); route groups are discovered by directory scan (Story 68.9).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GUARD_ROOT_ENV } from './guard-root.js'
import { projectRouteExists, routeExists, routeGroupRoots } from './route-exists.js'

describe('routeExists', () => {
  it('finds a static page nested inside a route group', () => {
    expect(routeExists('/settings/notifications')).toBe(true)
  })

  it('finds a top-level static page with no route group', () => {
    expect(routeExists('/login')).toBe(true)
  })

  // Regression guard: /settings/security was linked from five places before it had a route,
  // silently 404ing. This confirms the route now really exists on disk.
  it('finds the /settings/security MFA enrollment page', () => {
    expect(routeExists('/settings/security')).toBe(true)
  })

  it('returns false for a path with no matching +page.svelte anywhere', () => {
    expect(routeExists('/this/route/does/not/exist')).toBe(false)
  })

  it('ignores query strings and trailing slashes', () => {
    expect(routeExists('/settings/notifications/?tab=routing')).toBe(true)
    expect(routeExists('/settings/notifications/')).toBe(true)
  })

  it('discovers the three PV route groups by directory scan', () => {
    const names = routeGroupRoots().map((root) => root.split('/').at(-1))
    expect(names).toEqual(expect.arrayContaining(['(app)', '(auth)', '(vault)']))
  })
})

describe('routeExists over a composed tree (Story 68.9 AC-6)', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function composedApp(pages: string[]): void {
    const root = mkdtempSync(join(tmpdir(), 'pv-route-groups-'))
    roots.push(root)
    for (const page of pages) {
      mkdirSync(join(root, 'src/routes', page), { recursive: true })
      writeFileSync(join(root, 'src/routes', page, '+page.svelte'), '<h1>x</h1>\n')
    }
    vi.stubEnv(GUARD_ROOT_ENV, root)
  }

  it('sees a CM route group the PV list never named', () => {
    composedApp(['(billing)/billing', '(app)/dashboard'])
    expect(routeExists('/billing')).toBe(true)
    expect(routeExists('/dashboard')).toBe(true)
  })

  it('still reports a dead CM link', () => {
    composedApp(['(billing)/billing'])
    expect(routeExists('/billing/invoices')).toBe(false)
  })

  it('scans through nested groups only', () => {
    composedApp(['(a)/(b)/deep', 'plain/(c)/notagroup'])
    expect(routeExists('/deep')).toBe(true)
    expect(routeExists('/notagroup')).toBe(false)
  })

  it('does not treat ( ) () or (a(b)) as route groups', () => {
    composedApp(['(/x', '()/y', '(a(b))/z'])
    expect(routeExists('/x')).toBe(false)
    expect(routeExists('/y')).toBe(false)
    expect(routeExists('/z')).toBe(false)
  })

  it('does not match a [param] segment (existing documented limitation)', () => {
    composedApp(['items/[id]'])
    expect(routeExists('/items/42')).toBe(false)
    expect(projectRouteExists('')).toBe(false)
  })
})
