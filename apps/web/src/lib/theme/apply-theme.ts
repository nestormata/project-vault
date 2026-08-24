/**
 * Story 16.2 AC-2/AC-3 — pure, framework-agnostic theme-selection logic. Deliberately holds no
 * DOM/Svelte-store side effects itself: the actual `data-theme` attribute and compiled-CSS
 * delivery live in `(app)/+layout.svelte` (via `<svelte:element this="style">`, never the `@html`
 * directive — this repo's static-hardening gate forbids that directive entirely, see
 * `apps/web/src/lib/security/static-hardening.test.ts`) and `$lib/state/theme.svelte.ts`'s shared
 * rune. Keeping this file pure makes every rule here trivially unit-testable without a DOM.
 *
 * Story 25.3 AC4/Task 1 — the resolution functions themselves (`resolveAppliedTheme`,
 * `resolveAppliedThemeWithOrgDefault`, `isOrphaned`, `shouldShowOrphanedNotice`) moved to
 * `@project-vault/shared` (`packages/shared/src/utils/apply-theme.ts`) so `apps/api`'s
 * `renderExtensionPanel()` can call the exact same three-tier resolution for an extension panel's
 * `theme.name` context field, rather than a divergent reimplementation. Re-exported here
 * unchanged so every existing import site (`(app)/+layout.server.ts`, this file's own
 * `apply-theme.test.ts`) keeps working with zero behavior change. The `sessionStorage`-backed
 * dismissal-key helpers below have no server-side use case and stay owned by `apps/web`.
 */
export {
  isOrphaned,
  resolveAppliedTheme,
  resolveAppliedThemeWithOrgDefault,
  shouldShowOrphanedNotice,
} from '@project-vault/shared'

/**
 * AC-3's concrete dismissal-key design: a single sessionStorage key holding the *name* of the
 * theme that was last dismissed (not a generic boolean flag). This means dismissing the notice
 * only suppresses it for that exact orphaned theme name for the rest of the browser session — a
 * newly-orphaned *different* theme name correctly re-shows the notice (see
 * `shouldShowOrphanedNotice` above).
 */
export const ORPHANED_THEME_DISMISSAL_KEY = 'dismissedOrphanedTheme'

export function readDismissedOrphanedTheme(storage: Pick<Storage, 'getItem'>): string | null {
  return storage.getItem(ORPHANED_THEME_DISMISSAL_KEY)
}

export function writeDismissedOrphanedTheme(
  storage: Pick<Storage, 'setItem'>,
  themeName: string
): void {
  storage.setItem(ORPHANED_THEME_DISMISSAL_KEY, themeName)
}
