// Story 68.6 AC-7/AC-8 (design §8.3) — protected paths as data. `isProtectedRequest` is the ONE
// function that answers "protected?" (both the vault-readiness check and the anonymous redirect).
//
// A request is protected when ANY of:
//   - its pathname matches a protected prefix (segment-prefix: `p` itself or `p/...`);
//   - Kit's matched route id, with `(group)` segments removed, matches a protected prefix. Without
//     a reroute this is true iff the first test is, so PV's own behaviour is unchanged; with a
//     reroute (`/r/dash` -> `/dashboard`) or a percent-encoded URL (`/%73ettings/...`, which Kit
//     decodes for matching but not in `event.url.pathname`) it closes the bypass (Q5);
//   - the route id is one the composer derived from a CM route under `(app)` (exact, Q4).
// Remote functions (`/_app/remote/...`) carry no route id and are not gated here (Q9): they must
// call `requireUser` themselves.
import { stripRouteGroups } from '$lib/composition/route-id.js'

export const PV_PROTECTED_PREFIXES: readonly string[] = Object.freeze([
  '/dashboard',
  '/projects',
  '/credentials',
  '/alerts',
  '/health',
  '/settings',
  '/platform',
  '/notifications',
  // Story 25.1 AC1: defense in depth alongside the API-side secureRoute() gate — an
  // unauthenticated browser is redirected to /login before this route even renders
  // server-side.
  '/extensions/panels',
])

/** The guard's own redirect targets: protecting one is a guaranteed redirect loop (Q8). */
export const GUARD_REDIRECT_TARGETS: readonly string[] = Object.freeze([
  '/login',
  '/register',
  '/vault',
])

export interface ContributedProtectedPaths {
  routeIds: readonly string[]
  add: readonly string[]
  remove: readonly string[]
}

/** Frozen arrays (not a Set: a Set cannot be frozen, and this data is shared by every request). */
export interface ProtectedPaths {
  prefixes: readonly string[]
  routeIds: readonly string[]
}

export interface ProtectedRequest {
  pathname: string
  routeId: string | null
}

export const EMPTY_CONTRIBUTED_PATHS: ContributedProtectedPaths = Object.freeze({
  routeIds: [],
  add: [],
  remove: [],
})

export function matchesPrefix(prefixes: readonly string[], pathname: string): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** `prefixes = pv ∪ add − remove`, `routeIds = derived − remove`. Fails on a redirect loop. */
export function composeProtectedPaths(
  pv: readonly string[],
  contributed: ContributedProtectedPaths
): ProtectedPaths {
  const removed = new Set(contributed.remove)
  const prefixes = [...new Set([...pv, ...contributed.add])].filter((p) => !removed.has(p))
  const routeIds = contributed.routeIds.filter((id) => !removed.has(id))
  const loops: string[] = []
  for (const target of GUARD_REDIRECT_TARGETS) {
    for (const prefix of prefixes) {
      if (matchesPrefix([prefix], target))
        loops.push(`protected prefix "${prefix}" covers the guard redirect target ${target}`)
    }
    for (const id of routeIds) {
      if (stripRouteGroups(id) === target)
        loops.push(`protected route "${id}" covers the guard redirect target ${target}`)
    }
  }
  if (loops.length > 0) throw new Error(`${loops.join('; ')} (redirect loop)`)
  return Object.freeze({
    prefixes: Object.freeze(prefixes),
    routeIds: Object.freeze([...new Set(routeIds)]),
  })
}

export function isProtectedRequest(paths: ProtectedPaths, req: ProtectedRequest): boolean {
  if (matchesPrefix(paths.prefixes, req.pathname)) return true
  if (req.routeId === null) return false
  return (
    paths.routeIds.includes(req.routeId) ||
    matchesPrefix(paths.prefixes, stripRouteGroups(req.routeId))
  )
}
