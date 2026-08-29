import type { ExtensionNavItem } from '@project-vault/extension-api'
import { apiFetch } from './client.js'

/**
 * Story 29.3 AC11 — the client's own mirror of the resolved, extension-declared `navItems`
 * entries `apps/api`'s `GET /extensions/nav` returns. Structurally identical to
 * `ExtensionNavItem`, kept as its own alias (like `ExtensionNav` below) so this file's public
 * surface reads self-contained without requiring every caller to know the underlying manifest
 * type.
 */
export type ResolvedExtensionNavItem = ExtensionNavItem

/**
 * Story 25.12 AC2 — this client's own mirror of `apps/api/src/lib/extension-panel.ts`'s
 * `DEFAULT_PANEL_DATA_PATHS` (the exact pre-existing hardcoded pair). Lives here (not
 * `+page.server.ts`) because SvelteKit's page-server module only permits a fixed, known set of
 * exports (`load`, `prerender`, etc., or anything `_`-prefixed) — re-exporting an arbitrary named
 * constant from `+page.server.ts` fails at request time with "Invalid export". Used as the
 * degraded-path default for `ExtensionPanelPageData.allowedDataPaths` when the API call itself
 * failed, matching `actionEndpoint: undefined`'s existing degraded-branch convention.
 */
export const DEFAULT_PANEL_DATA_PATHS = ['/api/v1/projects', '/api/v1/projects/:id'] as const

// Story 25.1 AC1/AC3/AC3b: mirrors apps/api/src/extensions/panel-routes.ts's response shapes
// exactly. `ok: false` is the SAME shape for every degraded cause (throw, timeout, malformed
// result, or a permanently-absent hook) — callers must never try to distinguish these from the
// client, only render the calm "unavailable" state.
// Story 25.5 AC4/Task 4: actionEndpoint is present only when the loaded extension declares
// moduleActions for this slot — undefined (never '') when it does not, matching
// apps/api's own actionEndpoint contract.
// Story 25.12 AC2: allowedDataPaths is ALWAYS present on the ok branch (never undefined) —
// mirrors apps/api's ExtensionPanelOkSchema exactly (at minimum the two-entry legacy default).
export type ExtensionPanelResult =
  | { ok: true; html: string; actionEndpoint?: string; allowedDataPaths: string[] }
  | { ok: false; reason: 'panel_unavailable' }

// Story 25.8 AC1/Task 1 — `subpath` is forwarded as a query parameter on this SAME existing
// call, matching `projectId`/`resourceId`'s own convention (apps/api's PanelQuery) — it is
// NEVER concatenated into the `:slot` path segment itself, so that route's own
// `knownSlots.includes(slot)` exact-match validation stays untouched.
export function getExtensionPanel(fetchFn: typeof fetch, slot: string, subpath?: string) {
  const query = subpath !== undefined ? `?${new URLSearchParams({ subpath }).toString()}` : ''
  return apiFetch<ExtensionPanelResult>(
    fetchFn,
    `/api/v1/extensions/panels/${encodeURIComponent(slot)}${query}`
  )
}

// Story 25.1 AC5: drives (app)/+layout.server.ts's generic nav-entry decision. `null` means "no
// nav entry" (no extension loaded, or the loaded extension does not declare the `'ui-panel'`
// capability) — a non-null value is the fixed slot this story hardcodes ('group').
// Story 29.3 AC11: navItems is ALWAYS present ([] when none declared or no extension loaded,
// never undefined), matching apps/api's own ExtensionNavSchema contract exactly — resolved
// independently of uiPanelSlot/the 'ui-panel' capability (AC1's independence decision).
export type ExtensionNav = { uiPanelSlot: string | null; navItems: ResolvedExtensionNavItem[] }

export function getExtensionNav(fetchFn: typeof fetch) {
  return apiFetch<ExtensionNav>(fetchFn, '/api/v1/extensions/nav')
}
