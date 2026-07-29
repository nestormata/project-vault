/**
 * Story 16.2 AC-2/AC-3 — pure, framework-agnostic theme-selection logic. Deliberately holds no
 * DOM/Svelte-store side effects itself: the actual `data-theme` attribute and compiled-CSS
 * delivery live in `(app)/+layout.svelte` (via `<svelte:element this="style">`, never the `@html`
 * directive — this repo's static-hardening gate forbids that directive entirely, see
 * `apps/web/src/lib/security/static-hardening.test.ts`) and `$lib/state/theme.svelte.ts`'s shared
 * rune. Keeping this file pure makes every rule here trivially unit-testable without a DOM.
 */

/**
 * AC-3's concrete dismissal-key design: a single sessionStorage key holding the *name* of the
 * theme that was last dismissed (not a generic boolean flag). This means dismissing the notice
 * only suppresses it for that exact orphaned theme name for the rest of the browser session — a
 * newly-orphaned *different* theme name correctly re-shows the notice (see
 * `shouldShowOrphanedNotice` below).
 */
export const ORPHANED_THEME_DISMISSAL_KEY = 'dismissedOrphanedTheme'

/**
 * AC-2/AC-3: the theme actually applied to the page is the user's stored selection IF it is
 * still in the currently-available (compiled) set, otherwise the base theme (`null`) — orphaning
 * never auto-substitutes a different custom theme.
 */
export function resolveAppliedTheme(
  selectedThemeName: string | null,
  availableThemeNames: readonly string[]
): string | null {
  if (selectedThemeName === null) return null
  return availableThemeNames.includes(selectedThemeName) ? selectedThemeName : null
}

/**
 * Story 16.4 AC-2/AC-6 — three-tier resolution: personal selection (if non-null AND currently
 * valid) wins unconditionally over the org default; else the org default (if non-null AND
 * currently valid) applies; else the base theme (`null`). Each tier is independently re-checked
 * against `availableThemeNames` for orphaning — a personal selection that's orphaned never falls
 * through to an *invalid* org default, it falls through to a *valid* org default or base, exactly
 * like `resolveAppliedTheme` already does for the personal-only case. Deliberately a small, pure
 * function distinct from (not built by chaining) `resolveAppliedTheme` twice ad hoc, so this
 * three-tier rule itself stays independently unit-testable.
 */
export function resolveAppliedThemeWithOrgDefault(
  selectedThemeName: string | null,
  orgDefaultThemeName: string | null,
  availableThemeNames: readonly string[]
): string | null {
  if (selectedThemeName !== null && availableThemeNames.includes(selectedThemeName)) {
    return selectedThemeName
  }
  if (orgDefaultThemeName !== null && availableThemeNames.includes(orgDefaultThemeName)) {
    return orgDefaultThemeName
  }
  return null
}

/** AC-3: true exactly when the user has a non-null stored selection that is no longer available. */
export function isOrphaned(
  selectedThemeName: string | null,
  availableThemeNames: readonly string[]
): boolean {
  return selectedThemeName !== null && !availableThemeNames.includes(selectedThemeName)
}

/**
 * AC-3 — the notice is shown unless the *exact* orphaned theme name was already dismissed this
 * session. A different theme becoming orphaned later always re-shows it, even if some other name
 * was previously dismissed.
 */
export function shouldShowOrphanedNotice(
  orphanedThemeName: string,
  dismissedThemeName: string | null
): boolean {
  return orphanedThemeName !== dismissedThemeName
}

export function readDismissedOrphanedTheme(storage: Pick<Storage, 'getItem'>): string | null {
  return storage.getItem(ORPHANED_THEME_DISMISSAL_KEY)
}

export function writeDismissedOrphanedTheme(
  storage: Pick<Storage, 'setItem'>,
  themeName: string
): void {
  storage.setItem(ORPHANED_THEME_DISMISSAL_KEY, themeName)
}
