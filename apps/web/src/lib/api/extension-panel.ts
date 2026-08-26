import { apiFetch } from './client.js'

// Story 25.1 AC1/AC3/AC3b: mirrors apps/api/src/extensions/panel-routes.ts's response shapes
// exactly. `ok: false` is the SAME shape for every degraded cause (throw, timeout, malformed
// result, or a permanently-absent hook) — callers must never try to distinguish these from the
// client, only render the calm "unavailable" state.
// Story 25.5 AC4/Task 4: actionEndpoint is present only when the loaded extension declares
// moduleActions for this slot — undefined (never '') when it does not, matching
// apps/api's own actionEndpoint contract.
export type ExtensionPanelResult =
  { ok: true; html: string; actionEndpoint?: string } | { ok: false; reason: 'panel_unavailable' }

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
export type ExtensionNav = { uiPanelSlot: string | null }

export function getExtensionNav(fetchFn: typeof fetch) {
  return apiFetch<ExtensionNav>(fetchFn, '/api/v1/extensions/nav')
}
