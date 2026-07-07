import { describe, expect, it } from 'vitest'
import { routeExists } from './route-exists.js'

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
})
