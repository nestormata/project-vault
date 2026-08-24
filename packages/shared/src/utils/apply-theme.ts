/**
 * Story 16.2/16.4 AC-2/AC-3/AC-6 — pure, framework-agnostic theme-selection logic, originally
 * authored in `apps/web/src/lib/theme/apply-theme.ts` and moved here (Story 25.3 AC4/Task 1) so
 * both `apps/web` (the visible app shell) and `apps/api` (`renderExtensionPanel()`'s `theme.name`
 * context field) call the exact same resolution function — a divergence between what an
 * extension panel *thinks* the theme is and what PV *actually renders* around it would be a
 * confusing, hard-to-diagnose bug class. `apps/web/src/lib/theme/apply-theme.ts` re-exports these
 * functions unchanged so its own existing imports/tests keep working with zero behavior change;
 * it also still separately owns the DOM/`sessionStorage`-dependent dismissal-key helpers, which
 * have no server-side use case and stay there.
 */

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
