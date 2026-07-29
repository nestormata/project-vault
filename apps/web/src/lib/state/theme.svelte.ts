/**
 * Story 16.2 AC-2/AC-6 — shared, app-wide reactive theme state, mirroring
 * `notifications.svelte.ts`'s `unreadCount` rune pattern: `(app)/+layout.server.ts` resolves the
 * initial `appliedTheme` from the DB on every load (never cached in the session/JWT, AC-6), the
 * root layout seeds this rune from that server data, and `(app)/settings/themes/`'s page updates
 * it directly (pessimistically, only after a successful PATCH response — AC-2's pessimistic-UI
 * requirement) so every part of the already-mounted app re-renders with the new theme
 * immediately, with no navigation and no full-page reload.
 */
let appliedTheme = $state<string | null>(null)

export function getAppliedTheme(): string | null {
  return appliedTheme
}

export function setInitialAppliedTheme(themeName: string | null): void {
  appliedTheme = themeName
}

export function setAppliedTheme(themeName: string | null): void {
  appliedTheme = themeName
}
