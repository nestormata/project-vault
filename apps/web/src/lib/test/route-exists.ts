import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { guardSourceRoot } from './guard-root.js'

// Story 68.9 AC-6: the routes directory of the tree under test, PV's own or a composed app root.
// Deliberately not `new URL('../../routes', import.meta.url)` — Vite's import-analysis plugin
// statically rewrites that exact pattern into a dev-server asset URL (e.g.
// `http://localhost:3000/src/routes`) regardless of intent, which breaks fs-path resolution here.
function routesRoot(): string {
  return path.join(guardSourceRoot(), 'routes')
}

// SvelteKit's definition of a route group: a directory whose whole name is `(name)`.
const ROUTE_GROUP = /^\([^()]+\)$/

/** `routes/` plus every route group under it, recursing only through groups (a group may nest in
 * a group; groups are layout-only and never appear in the URL). */
export function routeGroupRoots(root: string = routesRoot()): string[] {
  if (!existsSync(root)) return []
  const groups = readdirSync(root)
    .filter((entry) => ROUTE_GROUP.test(entry) && statSync(path.join(root, entry)).isDirectory())
    .sort()
  return [root, ...groups.flatMap((group) => routeGroupRoots(path.join(root, group)))]
}

/** Shared directory-walk: does `+page.svelte` exist under any route group for these segments? */
function existsInAnyRouteGroup(...segments: string[]): boolean {
  return routeGroupRoots().some((root) => existsSync(path.join(root, ...segments, '+page.svelte')))
}

/**
 * Verifies a static URL path resolves to a real `+page.svelte` route on disk. Only handles
 * static, non-dynamic segments (no `[param]` matching) — enough to catch links like
 * `/settings/security` that were never wired up to an actual route.
 */
export function routeExists(urlPath: string): boolean {
  const queryStart = urlPath.indexOf('?')
  const pathOnly = queryStart === -1 ? urlPath : urlPath.slice(0, queryStart)
  const segments = pathOnly.split('/').filter((segment) => segment.length > 0)
  return existsInAnyRouteGroup(...segments)
}

/**
 * 12-1 AC-18: routeExists can't see past a dynamic `[param]` segment — it only matches literal
 * path segments on disk. The project sub-nav's hrefs are all `/projects/:id/<suffix>`, so this
 * checks the real `[projectId]` directory for a given static suffix (e.g. 'members', '' for the
 * overview page itself) instead of duplicating routeExists's whole directory-walk for one case.
 */
export function projectRouteExists(suffix: string): boolean {
  const segments = suffix.split('/').filter((segment) => segment.length > 0)
  return existsInAnyRouteGroup('projects', '[projectId]', ...segments)
}
