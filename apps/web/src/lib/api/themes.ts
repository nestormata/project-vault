import { apiFetch } from './client.js'

export type ThemeListItem = { name: string; label: string; css: string | null }
export type ThemeListResponse = { themes: ThemeListItem[]; selected: string | null }
export type ThemeSelectionResponse = { themeName: string | null }
export type ThemeReloadResponse = {
  loaded: string[]
  failed: { file: string; reason: string }[]
}

/** Story 16.2 AC-1 — every currently available theme (base + successfully-compiled custom
 * themes) plus the caller's own raw stored selection (which may reference a theme no longer in
 * the list — an "orphaned" selection, see AC-3). */
export function getThemes(fetchFn: typeof fetch) {
  return apiFetch<ThemeListResponse>(fetchFn, '/api/v1/themes')
}

/** Story 16.2 AC-2 — self-service theme selection; the endpoint takes no userId, it operates
 * exclusively on the authenticated session's own user row. `themeName: null` clears back to the
 * base theme. */
export function patchThemeSelection(fetchFn: typeof fetch, themeName: string | null) {
  return apiFetch<ThemeSelectionResponse>(fetchFn, '/api/v1/themes/selection', {
    method: 'PATCH',
    body: JSON.stringify({ themeName }),
  })
}

/** Story 16.3 AC-2/AC-3 — OrgAdmin-only, MFA-required, rate-limited manual reload trigger. Mirrors
 * `apps/web/src/lib/api/platform.ts`'s `triggerBackup(fetchFn)` exactly: a bare POST, no body. */
export function triggerThemeReload(fetchFn: typeof fetch) {
  return apiFetch<ThemeReloadResponse>(fetchFn, '/api/v1/admin/themes/reload', {
    method: 'POST',
  })
}
