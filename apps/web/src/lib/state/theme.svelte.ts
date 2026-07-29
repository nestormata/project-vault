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

/**
 * Story 16.4 Task 7.2 — small, deliberate extension for the pre-auth login screen. The `(app)`
 * layout above gets its theme CSS from a server `load()` (`themeCss`, delivered SSR alongside
 * `appliedTheme`) — there is no equivalent server load for the `(auth)` layout (a themeable
 * pre-auth org isn't resolvable until the domain-lookup response arrives client-side, AC-3), so
 * CSS must arrive from that response instead and be carried in its own piece of rune state,
 * distinct from `appliedTheme`/no `themeCss` counterpart above. Deliberately NOT reusing
 * `setAppliedTheme`/`appliedTheme` for this — those are seeded from the authenticated (app)
 * layout's SSR load and must never be silently overwritten by an unauthenticated, client-only
 * domain-lookup response reactivity.
 */
let preAuthThemeName = $state<string | null>(null)
let preAuthThemeCss = $state<string | null>(null)

export function getPreAuthThemeName(): string | null {
  return preAuthThemeName
}

export function getPreAuthThemeCss(): string | null {
  return preAuthThemeCss
}

export function setPreAuthTheme(themeName: string | null, css: string | null): void {
  preAuthThemeName = themeName
  preAuthThemeCss = css
}
