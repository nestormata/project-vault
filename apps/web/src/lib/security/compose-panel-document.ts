import { EXTENSION_THEME_CSS_VARS } from './extension-theme-vars.js'
import type { ExtensionThemeVars } from './extension-theme-vars.js'

/**
 * Story 25.4 AC1 — the composed panel document's Content-Security-Policy, delivered via a
 * `<meta http-equiv>` tag (`srcdoc` content has no response of its own to attach an HTTP header
 * to). Kept as a named constant, pinned exactly, with this comment cross-referencing the story's
 * own per-directive rationale (mirrors Story 25.1's own `allow-same-origin` comment-density
 * precedent for security-critical constants):
 *
 * - `default-src 'none'` — deny everything not explicitly allowed below; blocks all network
 *   resource loading (images, fonts, XHR/`fetch`, WebSocket, nested frames). This deliberately
 *   also blocks CentralizeMe's real, currently-inert `fetch(actionEndpoint)` action-dispatch code
 *   path — an explicit, accepted consequence (Story 25.5's own story must account for widening
 *   `connect-src` when it wires that path for real; this story adds NO `connect-src` allowance).
 * - `script-src 'unsafe-inline'` — does not reduce script trust below what the iframe's own
 *   `sandbox="allow-scripts"` (Story 25.1 AC4) already grants; a nonce/hash-based policy was
 *   considered and rejected (it would require parsing/rewriting the extension's own HTML, a new
 *   fragile surface, for a security property `allow-scripts` already conceded).
 * - `style-src 'unsafe-inline'` — real panels ship inline `<style>` blocks; no external
 *   stylesheet is used anywhere today.
 * - `base-uri 'none'` — Red Team finding: an extension's returned fragment (placed in `<body>`)
 *   could still include a `<base href="...">` that browsers honor regardless of tree position.
 *   Currently redundant with `default-src 'none'`, but cheap, and closes the door before any
 *   future directive relaxation would make a `<base>`-based relative-URL redirection meaningful.
 * - `form-action 'none'` — defense-in-depth on top of the iframe sandbox's own missing
 *   `allow-forms` token (native form submission is already blocked either way).
 *
 * No `img-src`, `font-src`, or `connect-src` directive is added speculatively — the real consumer
 * this story was calibrated against needs none of them today.
 */
export const EXTENSION_PANEL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

function buildThemeStyleBlock(themeVars: ExtensionThemeVars): string {
  const declarations = EXTENSION_THEME_CSS_VARS.map(
    (name) => `  ${name}: ${themeVars[name]};`
  ).join('\n')
  return `<style>:root {\n${declarations}\n}</style>`
}

/**
 * Story 25.4 AC1/AC4/AC6 (Task 1) — the ONLY place `apps/web` composes the full, host-controlled
 * `srcdoc` document assigned to the extension panel iframe. Narrow and purpose-built (CSP meta +
 * theme `:root {}` block + the extension's own fragment, verbatim) — deliberately NOT a
 * general-purpose HTML-sanitize-or-transform utility (AC6 scope boundary). AC2 (RESOLVED: no
 * sanitizer) means `extensionHtml` is never parsed, stripped, or rewritten here — it is placed
 * into `<body>` exactly as returned, relying entirely on this CSP plus the existing
 * `sandbox="allow-scripts"` boundary as the real controls.
 *
 * Called fresh on every render (no memoized template) — Task 1/Boundary Sweep requirement, so one
 * user's extension output is never accidentally cached and served to another.
 */
/**
 * Story 25.5 AC4/Task 4 — `actionsOrigin` (default `undefined`) widens the CSP with exactly
 * `connect-src <actionsOrigin>`, closing the forward obligation Story 25.4 flagged for this
 * story. This is conditional, not unconditional: a panel from an extension declaring no
 * `moduleActions` renders with exactly Story 25.4's original, narrower CSP (no `connect-src` at
 * all), a deliberate Boundary & Edge Case Sweep finding.
 *
 * **Bug fix (2026-08-24, found via real Chrome-driven manual verification, not caught by any
 * unit test):** this originally used the `'self'` keyword, per the story's own AC4 text. That
 * does not work. The panel iframe is `sandbox="allow-scripts"` with NO `allow-same-origin` (a
 * deliberate, non-negotiable Story 25.1 requirement), which forces the iframe's document into a
 * unique, opaque origin. Per the CSP spec, `'self'` resolves to the requesting document's own
 * origin — an opaque origin never equals any concrete origin, so `connect-src 'self'` silently
 * blocks every fetch from this iframe before any network activity even starts (confirmed live:
 * clicking the fixture's action button produced a caught `fetch` rejection, zero network
 * requests). The fix is to pass the real, concrete PV origin as an explicit source value
 * instead — still exactly one literal origin (never a wildcard, never multiple), just named
 * rather than relying on a keyword that can never resolve inside this sandbox configuration.
 */
export function composePanelDocument(
  extensionHtml: string,
  themeVars: ExtensionThemeVars,
  actionsOrigin?: string
): string {
  const themeStyleBlock = buildThemeStyleBlock(themeVars)
  const csp =
    actionsOrigin !== undefined
      ? `${EXTENSION_PANEL_CSP}; connect-src ${actionsOrigin}`
      : EXTENSION_PANEL_CSP
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `${themeStyleBlock}</head><body>${extensionHtml}</body></html>`
  )
}
