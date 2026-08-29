import DOMPurify from 'dompurify'
import type { Action } from 'svelte/action'

/**
 * Story 29.1 — the sanitize-and-inject Svelte action that replaces the `<iframe sandbox
 * srcdoc={...}>` mechanism (Story 25.1/25.4) for rendering a CentralizeMe extension panel's raw
 * HTML inline into PV's own DOM. This is the primary security control now that the panel shares
 * PV's own origin/session — there is no sandbox boundary absorbing an XSS-shaped bug in the
 * extension's HTML-generation code any more (see this story's Dev Notes "Why sanitize now").
 *
 * Deliberately a `use:` action backing an imperative `element.innerHTML = sanitized` assignment,
 * never a Svelte template at-html directive — `svelte/no-at-html-tags` (error, zero
 * `eslint-disable` tolerated, `packages/eslint-config/index.js`) scans for the template
 * directive's syntax specifically; this targets fundamentally different syntax and genuinely
 * does not trigger the rule (AC2/AC3), matching the same category of distinction Story 25.1
 * already established when it chose the iframe specifically to sidestep this same lint rule.
 *
 * AC13 — DOMPurify is configured explicitly, never left to its bare defaults:
 * - `FORBID_TAGS: ['iframe', 'object', 'embed']` — CentralizeMe's HTML could otherwise
 *   re-introduce a nested browsing context inside the very surface this story removes an iframe
 *   from (Security Audit Personas, Elicitation Log #1).
 * - `SANITIZE_DOM: true` (DOMPurify's own default) is left enabled — mXSS-hardening must not be
 *   disabled.
 * - `afterSanitizeAttributes` hook forces `rel="noopener noreferrer"` on any surviving
 *   `target="_blank"` element — reverse-tabnabbing is a real risk once the link renders in PV's
 *   own origin/session rather than an opaque-origin sandboxed document.
 *
 * AC14 — the sanitize+assign call is wrapped in try/catch: any exception (a malformed input, a
 * future DOMPurify bug) clears the element's content and is swallowed rather than propagating
 * through Svelte's render tree and breaking the whole page, matching the AC5 degraded-placeholder
 * fail-safe posture but scoped to just this element.
 *
 * AC16(c) — `null` and `''` are treated distinctly from each other only insofar as both produce
 * an empty, harmless container; `+page.svelte`'s own `data.html !== null` conditional (unchanged
 * by this story) is what decides whether this action's container renders at all versus the
 * degraded placeholder — this function itself needs no special-casing between them.
 */
const SANITIZE_CONFIG = {
  // AC13(a) — `iframe`/`object`/`embed` forbidden per the story's own explicit requirement.
  //
  // Story 29.1 Task 5 (AC12) — `style`/`link` are ADDITIONALLY forbidden here, beyond AC13's own
  // list. This is this story's chosen mitigation for the style-isolation regression
  // `panel-style-isolation.test.ts` used to guard structurally via the iframe's separate
  // `Document` (see that test file's own updated comment): once the panel shares PV's own
  // document, a `<style>` block or `<link rel="stylesheet">` in the extension's HTML would no
  // longer be contained to an isolated document — it would apply page-wide, and could just as
  // easily be used (accidentally or not) to target PV's own chrome via an attacker-chosen
  // selector. Forbidding both tags forces extension styling through inline `style` attributes
  // only (which every real panel already uses — see `fixtures/mock-ui-panel-extension`'s
  // `var(--pv-ext-ink, ...)` pattern) — a real, testable mitigation for the highest-severity part
  // of the lost isolation guarantee, though not a full restoration of it (see that test file's
  // Dev Notes cross-reference for what remains an accepted, documented regression: PV's own
  // compiled CSS cascade now reaches panel-rendered elements, and vice versa, for anything not
  // scoped via a `<style>`/`<link>` tag specifically).
  FORBID_TAGS: ['iframe', 'object', 'embed', 'style', 'link'],
  SANITIZE_DOM: true,
  // DOMPurify's default ALLOWED_ATTR list does not include `target` — added explicitly so a
  // legitimate `target="_blank"` link survives sanitization at all, which the
  // `afterSanitizeAttributes` hook below then requires in order to enforce
  // `rel="noopener noreferrer"` on it (AC13(b)).
  ADD_ATTR: ['target'],
}

function forceNoopenerNoreferrerOnBlankLinks(node: Element): void {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    node.setAttribute('rel', 'noopener noreferrer')
  }
}

// Registering the hook at module scope (rather than guarding it) crashes SSR: SvelteKit's server
// bundle imports this module too — even though `renderPanelHtml` itself is a `use:` action that
// never executes server-side — and Node's `dompurify` export (no `window`) has no `addHook`
// method at all, unlike the browser bundle's window-bound instance. Registering lazily, on first
// real (client-side, browser) sanitize call, keeps this a true no-op during SSR while still
// guaranteeing the hook is present before any sanitize() call ever runs client-side.
let hookRegistered = false

function sanitizeAndAssign(element: HTMLElement, html: string | null): void {
  try {
    if (!hookRegistered) {
      DOMPurify.addHook('afterSanitizeAttributes', forceNoopenerNoreferrerOnBlankLinks)
      hookRegistered = true
    }
    const sanitized = html === null || html === '' ? '' : DOMPurify.sanitize(html, SANITIZE_CONFIG)
    element.innerHTML = sanitized
  } catch {
    // AC14 — fail safe: never let a sanitizer/DOM-assignment exception propagate through
    // Svelte's render tree. Clear whatever the container held rather than leaving stale content.
    try {
      element.innerHTML = ''
    } catch {
      // If even clearing the element throws (e.g. it was already detached), there is nothing
      // further this action can safely do — swallow, matching this function's fail-safe contract.
    }
  }
}

/**
 * Svelte action shape: `use:renderPanelHtml={data.html}`. Runs sanitize+assign once on mount and
 * again every time the bound parameter value changes (AC16(a) — rapid slot-navigation
 * re-renders correctly, leaking no previously-rendered content since each call fully replaces
 * `innerHTML`). `destroy()` is a no-op — `DOMPurify.sanitize()` is synchronous, so there is no
 * pending async work to cancel on unmount (AC16(b)).
 */
export const renderPanelHtml: Action<HTMLElement, string | null> = (element, html) => {
  sanitizeAndAssign(element, html)

  return {
    update(newHtml: string | null) {
      sanitizeAndAssign(element, newHtml)
    },
    destroy() {
      // No-op — see doc comment above (AC16(b)).
    },
  }
}
