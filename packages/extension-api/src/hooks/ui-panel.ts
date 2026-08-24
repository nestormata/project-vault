/**
 * AC2/AC3 — `UIPanel` is one of the three typed hook interfaces this package exports.
 * Serializable-data-only render result per architecture.md § Data Boundaries — an extension
 * returns markup/data for core to render, it never receives a live DOM/component reference.
 *
 * ### Story 25.4 AC5 — accessibility expectations for `onRenderPanel()`'s returned markup
 *
 * PV renders `UIPanelResult.html` inside a sandboxed `<iframe>` with a host-controlled,
 * slot-derived `title` (e.g. `"Extension panel: group"`) — the panel's own root element should
 * **not** duplicate a competing page-level heading role (PV's host page already announces the
 * panel via that `title` and its own on-page heading). Beyond that one host-owned constraint, PV
 * cannot lint or validate an extension's own returned markup for accessibility — this is
 * guidance, not an enforced contract. Panel authors should:
 *
 * - Return semantic HTML: real heading elements, labelled form controls, and `aria-live` regions
 *   for asynchronous status updates (CM's real `access-group/ui-panel.ts` is the positive example
 *   this guidance is calibrated against — its form handling, confirm `<dialog>`, and
 *   `aria-live="polite"` status region already follow this).
 * - Not assume any ambient stylesheet: the panel document is isolated (see AC3) and receives only
 *   PV's small `--pv-ext-*` custom-property theming contract (`EXTENSION_THEME_CSS_VARS` /
 *   `ExtensionThemeCssVar`, `theme-contract.ts`) — consume those via `var(--pv-ext-ink, #yourFallback)`
 *   with a hardcoded fallback, exactly like CM's existing `var(--cm-access-ink, #24323b)` pattern.
 */
export type UIPanelContext = {
  /** Which named panel slot core is asking the extension to render into. */
  slot: string
}

export type UIPanelResult = {
  /** Serializable HTML fragment for core to render into the requested slot. */
  html: string
}

export type UIPanel = {
  onRenderPanel(context: UIPanelContext): Promise<UIPanelResult>
}
