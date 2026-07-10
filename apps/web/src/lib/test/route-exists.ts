import { existsSync } from 'node:fs'
import path from 'node:path'

// Deliberately not `new URL('../../routes', import.meta.url)` — Vite's import-analysis plugin
// statically rewrites that exact pattern into a dev-server asset URL (e.g.
// `http://localhost:3000/src/routes`) regardless of intent, which breaks fs-path resolution here.
const ROUTES_ROOT = path.join(import.meta.dirname, '../../routes')

// SvelteKit route groups (parens) are layout-only and never appear in the URL, so a URL segment
// can live directly under `routes/` or nested one level inside any of these groups.
const ROUTE_GROUPS = ['(app)', '(auth)', '(vault)']

/**
 * Verifies a static URL path resolves to a real `+page.svelte` route on disk. Only handles
 * static, non-dynamic segments (no `[param]` matching) — enough to catch links like
 * `/settings/security` that were never wired up to an actual route.
 */
export function routeExists(urlPath: string): boolean {
  const queryStart = urlPath.indexOf('?')
  const pathOnly = queryStart === -1 ? urlPath : urlPath.slice(0, queryStart)
  const segments = pathOnly.split('/').filter((segment) => segment.length > 0)

  const candidateRoots = [
    ROUTES_ROOT,
    ...ROUTE_GROUPS.map((group) => path.join(ROUTES_ROOT, group)),
  ]

  return candidateRoots.some((root) => existsSync(path.join(root, ...segments, '+page.svelte')))
}
