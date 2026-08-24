/**
 * Story 25.4 AC4 — RESOLVED 2026-08-24 (Open Design Question 2, Option 1): a small, stable,
 * versioned "extension theming contract" PV publishes as part of this package's documented
 * surface, distinct from PV's own internal theme-token registry
 * (`packages/shared/src/constants/theme-tokens.ts`, which is PV chrome-only and never exposed to
 * extensions).
 *
 * PV's host (`apps/web`'s panel-document composition function) injects a `:root { ... }` `<style>`
 * block declaring every one of these custom properties, resolved from the theme actually applied
 * to the requesting user's own PV chrome, into every composed panel document — always, even when
 * no custom theme is applied (base/default chrome colors). An extension consumes them purely via
 * CSS `var()` with its own hardcoded fallback, e.g.:
 *
 * ```css
 * .cm-access-ink { color: var(--pv-ext-ink, #24323b); }
 * ```
 *
 * This is a one-way, read-only contract: PV publishes the properties and their values; an
 * extension is never required to consume them, and PV never reads anything back from the
 * extension's own CSS. See this story's Dev Agent Record for the concrete PV-token-to-`--pv-ext-*`
 * mapping the host composition function uses.
 */
export const EXTENSION_THEME_CSS_VARS = [
  '--pv-ext-surface',
  '--pv-ext-ink',
  '--pv-ext-muted',
  '--pv-ext-brand',
  '--pv-ext-line',
] as const

export type ExtensionThemeCssVar = (typeof EXTENSION_THEME_CSS_VARS)[number]
