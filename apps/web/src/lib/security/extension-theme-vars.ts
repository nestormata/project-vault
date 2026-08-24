import { EXTENSION_THEME_CSS_VARS } from '@project-vault/extension-api'
import type { ExtensionThemeCssVar } from '@project-vault/extension-api'

/**
 * Story 25.4 AC4 (Task 4) — resolves PV's small, published `--pv-ext-*` theming contract
 * (`EXTENSION_THEME_CSS_VARS`, `packages/extension-api`) into concrete color values for the
 * theme actually applied to the requesting user's own PV chrome, so the panel-document
 * composition function (`compose-panel-document.ts`) can inject them as a `:root {}` block.
 *
 * Deliberately does not use `packages/shared`'s `THEME_TOKENS` registry keys directly as the
 * published contract's own names (see Open Design Question 2 in the story file — a naming
 * contract between PV's own token names and any extension's names does not exist and this story
 * does not invent one) — instead each `--pv-ext-*` property maps to exactly one PV-compiled CSS
 * custom property, chosen for the closest matching semantics:
 *
 * | `--pv-ext-*` property | PV source                                            |
 * | ---------------------- | ------------------------------------------------------ |
 * | `--pv-ext-surface`      | `--color-background` (Story 16.1 `colorBackground`)    |
 * | `--pv-ext-ink`           | `--color-foreground` (Story 16.1 `colorForeground`)    |
 * | `--pv-ext-brand`         | `--color-primary-600` (Story 16.1 `colorPrimary600`)   |
 * | `--pv-ext-line`          | `--color-border` (Story 16.1 `colorBorder`)            |
 * | `--pv-ext-muted`         | *derived* — no analogous registered PV token exists     |
 *
 * `--pv-ext-muted` has no directly analogous entry in `THEME_TOKENS`
 * (`packages/shared/src/constants/theme-tokens.ts`) — rather than inventing a new PV-side theme
 * token for this story alone (explicitly out of scope per the sign-off), it is derived purely in
 * CSS from the two tokens already resolved above via `color-mix()`, so it always tracks whatever
 * theme (or base chrome) is actually applied.
 */
export type ExtensionThemeVars = Record<ExtensionThemeCssVar, string>

export type CompiledThemeLike = { name: string; css: string | null }

// PV's own base/default chrome colors — the literal values `apps/web` already renders with when
// no custom theme is applied (no compiled CSS exists for the base theme at all, see
// apps/api/src/modules/theming/selection-routes.ts's own comment: "the base theme is never part
// of 16.1's compiled-themes list"). Sourced directly from what PV's own chrome actually uses:
// `bg-white`/`text-gray-900`/`border-slate-200` (this route's own `+page.svelte`,
// `(app)/+layout.svelte`'s header) and `--color-brand-600` (`apps/web/src/app.css`).
const BASE_SURFACE = '#ffffff'
const BASE_INK = '#111827'
const BASE_BRAND = '#7c3aed'
const BASE_LINE = '#e2e8f0'

export const BASE_EXTENSION_THEME_VARS: ExtensionThemeVars = {
  '--pv-ext-surface': BASE_SURFACE,
  '--pv-ext-ink': BASE_INK,
  '--pv-ext-muted': `color-mix(in srgb, ${BASE_INK} 60%, ${BASE_SURFACE})`,
  '--pv-ext-brand': BASE_BRAND,
  '--pv-ext-line': BASE_LINE,
}

const SOURCE_CSS_VAR_BY_EXT_VAR: Record<
  Exclude<ExtensionThemeCssVar, '--pv-ext-muted'>,
  { cssName: string; base: string }
> = {
  '--pv-ext-surface': { cssName: '--color-background', base: BASE_SURFACE },
  '--pv-ext-ink': { cssName: '--color-foreground', base: BASE_INK },
  '--pv-ext-brand': { cssName: '--color-primary-600', base: BASE_BRAND },
  '--pv-ext-line': { cssName: '--color-border', base: BASE_LINE },
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Code-review hardening (Story 25.4 post-implementation review, 2026-08-24): the extracted value
// is interpolated verbatim into the composed document's `<style>:root {}` block
// (compose-panel-document.ts's `buildThemeStyleBlock`), which lands in `<head>` *before* the
// extension's own untrusted fragment. `apps/api`'s theming service already constrains compiled
// theme CSS to a narrow color grammar (hex or a tightly-bounded rgb()/rgba()/hsl()/hsla() form —
// see `isValidColorGrammar`, `apps/api/src/modules/theming/service.ts`) before it is ever
// persisted, but that invariant is enforced far away from this interpolation site and this file
// has no way to prove it still holds for every caller. Re-validating here — rather than trusting
// the upstream contract implicitly — means a bug in that upstream grammar, a future
// theme-authoring path that bypasses it, or simply a value this regex mis-extracts (e.g. a
// value with no trailing `;`, matched past its intended boundary) can never smuggle `</style>`,
// `<script>`, or a second `<meta http-equiv="Content-Security-Policy">` tag into this
// story's own host-controlled document. An extracted value that fails this check is treated
// exactly like a missing token: fall back to the safe, hardcoded base color.
// Mirrors `apps/api/src/modules/theming/service.ts`'s own `isValidColorGrammar` shape (split the
// function call into name + component list, validate each component independently) rather than
// one large regex with nested quantifiers — simpler to reason about and avoids the catastrophic-
// backtracking shape a single combined pattern would otherwise raise a lint warning for.
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/
const COLOR_FUNCTION = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/
const NUMERIC_COMPONENT = /^[0-9]{1,3}(?:\.[0-9]+)?%?$/
const COLOR_FUNCTION_ARITY: Record<string, [number, number]> = {
  rgb: [3, 3],
  rgba: [3, 4],
  hsl: [3, 3],
  hsla: [3, 4],
}

function isSafeThemeColorValue(value: string): boolean {
  if (HEX_COLOR.test(value)) return true

  const match = COLOR_FUNCTION.exec(value)
  if (!match) return false
  const [, fnName, body] = match
  if (!fnName || body === undefined) return false

  const components = body.split(',').map((component) => component.trim())
  const [min, max] = COLOR_FUNCTION_ARITY[fnName] ?? [0, 0]
  if (components.length < min || components.length > max) return false

  return components.every((component) => NUMERIC_COMPONENT.test(component))
}

function extractCssCustomProperty(css: string, cssName: string): string | null {
  // Bounded at `;` or `}` (not just `;`) so a value that happens to be the last declaration in a
  // block (no trailing semicolon) never runs past the rule's closing brace.
  const pattern = new RegExp(`${escapeForRegExp(cssName)}:\\s*([^;}]+)[;}]`)
  const extracted = pattern.exec(css)?.[1]?.trim() ?? null
  if (extracted === null || !isSafeThemeColorValue(extracted)) return null
  return extracted
}

/**
 * AC4 — resolves the `--pv-ext-*` value set for the theme actually applied to the requesting
 * user's own PV chrome (the same `resolveAppliedThemeWithOrgDefault()` result already computed by
 * the caller). `appliedThemeName: null` (base theme) and an unresolvable/orphaned name both
 * produce the identical, always-non-empty `BASE_EXTENSION_THEME_VARS` result — this function never
 * returns a partial/broken block.
 */
export function resolveExtensionThemeVars(
  appliedThemeName: string | null,
  themes: readonly CompiledThemeLike[]
): ExtensionThemeVars {
  const matchedTheme = appliedThemeName
    ? themes.find((theme) => theme.name === appliedThemeName)
    : undefined
  const css = matchedTheme?.css ?? ''

  const surface =
    extractCssCustomProperty(css, SOURCE_CSS_VAR_BY_EXT_VAR['--pv-ext-surface'].cssName) ??
    BASE_SURFACE
  const ink =
    extractCssCustomProperty(css, SOURCE_CSS_VAR_BY_EXT_VAR['--pv-ext-ink'].cssName) ?? BASE_INK
  const brand =
    extractCssCustomProperty(css, SOURCE_CSS_VAR_BY_EXT_VAR['--pv-ext-brand'].cssName) ?? BASE_BRAND
  const line =
    extractCssCustomProperty(css, SOURCE_CSS_VAR_BY_EXT_VAR['--pv-ext-line'].cssName) ?? BASE_LINE

  return {
    '--pv-ext-surface': surface,
    '--pv-ext-ink': ink,
    '--pv-ext-muted': `color-mix(in srgb, ${ink} 60%, ${surface})`,
    '--pv-ext-brand': brand,
    '--pv-ext-line': line,
  }
}

// Re-exported so callers building the composed document's `:root {}` block can iterate the
// published property list in its documented, stable order without importing from the
// extension-api package a second time.
export { EXTENSION_THEME_CSS_VARS }
