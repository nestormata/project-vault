// Story 68.6 AC-8 (design §8.3) — the composer derives protection for every CM route under
// `(app)` and validates `protectedPaths.add`/`remove`. Integrity only: a malformed entry, an entry
// in both lists, or a protected set that covers the guard's own redirect targets (a guaranteed
// redirect loop) fails; everything else, including removing PV's own prefixes, is allowed and
// recorded with a note. Nothing limits which paths CM may protect or unprotect.
import { compareCodeUnits, sortedCodeUnits } from './paths.js'
import { isAppGroupRoute, routeIdOfFile, stripRouteGroups } from './route-files.js'
import type { UiPackManifest } from './types.js'

export interface DerivedRoute {
  routeId: string
  urlPattern: string
}

export interface ProtectedPathsRecord {
  add: string[]
  remove: string[]
  derived: DerivedRoute[]
}

/** The guard's own redirect targets in PV's `handle`. */
const GUARD_REDIRECT_TARGETS = ['/login', '/register', '/vault']

/** Every CM-originated route (an addition or an override of a route file), by route id. */
export function cmRouteIds(paths: readonly string[]): string[] {
  const ids = paths.flatMap((path) => {
    const id = routeIdOfFile(path)
    return id === null ? [] : [id]
  })
  return sortedCodeUnits([...new Set(ids)])
}

/** The derived set: each CM route under `(app)`. */
export function deriveProtectedRoutes(paths: readonly string[]): DerivedRoute[] {
  return cmRouteIds(paths)
    .filter(isAppGroupRoute)
    .map((routeId) => ({ routeId, urlPattern: stripRouteGroups(routeId) }))
}

function covers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function addProblems(add: readonly string[]): string[] {
  return add.flatMap((entry) => {
    if (!entry.startsWith('/')) return [`protectedPaths.add "${entry}" must start with "/"`]
    if (entry.includes('?') || entry.includes('#'))
      return [`protectedPaths.add "${entry}" must not contain "?" or "#"`]
    if (entry.endsWith('/')) return [`protectedPaths.add "${entry}" must not end with "/"`]
    return []
  })
}

export interface ProtectedPathsInput {
  manifest: UiPackManifest
  /** CM-originated route files (additions and overrides), as composed-tree paths. */
  cmRouteFiles: readonly string[]
  /** PV's own protected prefixes (from web-host's hooks-surface.json). */
  pvPrefixes: readonly string[]
}

export interface ProtectedPathsFindings {
  record: ProtectedPathsRecord
  problems: string[]
  notes: string[]
  summary: string
}

function removeNotes(
  remove: readonly string[],
  prefixes: ReadonlySet<string>,
  derivedIds: ReadonlySet<string>,
  pvPrefixes: readonly string[]
): string[] {
  return remove.flatMap((entry) => {
    if (pvPrefixes.includes(entry))
      return [
        `PV prefix ${entry} is no longer protected by the hook; (app)/+layout.server.ts still redirects page loads, but actions and +server under it are now ungated`,
      ]
    if (prefixes.has(entry) || derivedIds.has(entry)) return []
    return [`protectedPaths.remove "${entry}" matches no protected prefix or derived route`]
  })
}

function loopProblems(prefixes: readonly string[], routes: readonly DerivedRoute[]): string[] {
  return GUARD_REDIRECT_TARGETS.flatMap((target) => [
    ...prefixes
      .filter((prefix) => covers(prefix, target))
      .map(
        (prefix) =>
          `protectedPaths: prefix "${prefix}" covers the guard redirect target ${target} (redirect loop)`
      ),
    ...routes
      .filter((route) => route.urlPattern === target)
      .map(
        (route) =>
          `protectedPaths: derived route "${route.routeId}" covers the guard redirect target ${target} (redirect loop)`
      ),
  ])
}

/** Derivation, validation, notes and the lock record for the protected-path contribution. */
export function protectedPathsFindings(input: ProtectedPathsInput): ProtectedPathsFindings {
  const add = input.manifest.protectedPaths?.add ?? []
  const remove = input.manifest.protectedPaths?.remove ?? []
  const derived = deriveProtectedRoutes(input.cmRouteFiles)
  const uniqueAdd = sortedCodeUnits([...new Set(add)])
  const uniqueRemove = sortedCodeUnits([...new Set(remove)])
  const removed = new Set(uniqueRemove)
  const problems = [
    ...addProblems(uniqueAdd),
    ...uniqueAdd
      .filter((entry) => removed.has(entry))
      .map((entry) => `"${entry}" is in both protectedPaths.add and protectedPaths.remove`),
  ]
  const notes = uniqueAdd
    .filter((entry) => add.indexOf(entry) !== add.lastIndexOf(entry))
    .map((entry) => `protectedPaths.add "${entry}" is listed twice; de-duplicated`)
  const allPrefixes = new Set([...input.pvPrefixes, ...uniqueAdd])
  const prefixes = [...allPrefixes].filter((prefix) => !removed.has(prefix))
  const routes = derived.filter((route) => !removed.has(route.routeId))
  problems.push(...loopProblems(prefixes, routes))
  notes.push(
    ...removeNotes(
      uniqueRemove,
      allPrefixes,
      new Set(derived.map((r) => r.routeId)),
      input.pvPrefixes
    )
  )
  const protectedIds = new Set(routes.map((route) => route.routeId))
  for (const id of cmRouteIds(input.cmRouteFiles)) {
    const url = stripRouteGroups(id)
    if (protectedIds.has(id) || prefixes.some((prefix) => covers(prefix, url))) continue
    if (isAppGroupRoute(id)) continue // removed on purpose; already noted
    notes.push(`CM route ${id} is public: not under (app) and not in protectedPaths.add`)
  }
  const summary =
    `protected paths: ${derived.length} derived (app) routes, ${uniqueAdd.length} added, ` +
    `${uniqueRemove.length} removed (${notes.length} note${notes.length === 1 ? '' : 's'})`
  return {
    record: { add: uniqueAdd, remove: uniqueRemove, derived },
    problems,
    notes: notes.sort(compareCodeUnits),
    summary,
  }
}
