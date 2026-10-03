// Story 68.6 — the ONE route-id helper the kit (and the repo's route discovery, 68-4) uses: a file
// under `src/routes/` maps to SvelteKit's route id exactly as Kit computes it (the directory path
// with groups kept). The integration job checks every derived id against Kit's own generated route
// list, so a disagreement with Kit fails loudly instead of leaving a protection gap.

const ROUTES_DIR = 'src/routes/'

/** Files that make a directory a route (Kit: a page or an endpoint). Layouts and error pages are
 * not routes. */
const ROUTE_FILE = /^\+(page(\.server)?\.(ts|js)|page\.svelte|server\.(ts|js))$/

export function isRouteFile(path: string): boolean {
  if (!path.startsWith(ROUTES_DIR)) return false
  const name = path.slice(path.lastIndexOf('/') + 1)
  return ROUTE_FILE.test(name)
}

/** `src/routes/(app)/cm-area/+page.svelte` -> `/(app)/cm-area`; `src/routes/+page.svelte` -> `/`. */
export function routeIdOfFile(path: string): string | null {
  if (!isRouteFile(path)) return null
  const dir = path.slice(ROUTES_DIR.length, path.lastIndexOf('/') + 1)
  const trimmed = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return `/${trimmed}`
}

/** `/(app)/(nested)/reports/[id]` -> `/reports/[id]`. A linear split, not a regex (Sonar S8786). */
export function stripRouteGroups(routeId: string): string {
  let url = ''
  for (const segment of routeId.split('/')) {
    const isGroup = segment.startsWith('(') && segment.endsWith(')')
    if (segment !== '' && !isGroup) url += `/${segment}`
  }
  return url === '' ? '/' : url
}

/** True for a route id inside the `(app)` group (its first segment). */
export function isAppGroupRoute(routeId: string): boolean {
  return routeId === '/(app)' || routeId.startsWith('/(app)/')
}
