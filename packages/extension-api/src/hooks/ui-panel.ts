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
  /**
   * Story 25.3 AC5 — optional, extension-owned resource identifier (e.g. an access-group or
   * document id). Shape-validated by the host (bounded length, restricted charset) before this
   * context is ever built, but the value itself is passed through verbatim with NO PV-side
   * lookup, membership check, or existence check — PV has no data model for what this refers to.
   * Unlike `projectId` below, an extension receiving this field is solely responsible for its own
   * authorization of whatever it identifies; PV is not vouching for its validity the way it
   * vouches for `projectId`.
   */
  resourceId?: string
  /**
   * Story 25.3 AC1/AC6 — who is asking, for personalization. Deliberately minimal: re-derived
   * fresh from the request's own resolved session on every call, never a client-supplied claim,
   * never cached across requests. `sessionId`, `jti`, `sessionVersion`, and `isPlatformOperator`
   * are deliberately excluded — session/replay-control material and an instance-wide superuser
   * flag have no verified personalization use case and must never reach in-process-but-untrusted
   * extension code. These fields are a point-in-time snapshot, not a live credential — an
   * extension needing to gate a specific mutation or resource read by live, re-verifiable
   * authorization must call `HostServices.orgAuthorization.checkMembership`, not branch on this
   * context alone.
   */
  identity: {
    userId: string
    orgRole: 'owner' | 'admin' | 'member' | 'viewer'
  }
  /** Story 25.3 AC1 — the caller's org, read directly from the request's resolved session. */
  orgId: string
  /**
   * Story 25.3 AC2 — optional, populated only when the client supplies a `?projectId=` query
   * parameter AND the caller is authorized to see that project (PV's existing project-visibility
   * gate). An unauthorized or nonexistent `projectId` never reaches this context — the request
   * fails closed before the hook is ever invoked, using the same non-leaking-existence response
   * shape as any other degraded case.
   */
  projectId?: string
  /**
   * Story 25.3 AC3 — resolved server-side from the caller's own stored locale preference, never
   * from an `Accept-Language` header, never a client-supplied value.
   */
  locale: 'en' | 'es'
  /**
   * Story 25.3 AC4 — machine-readable theme identity (personal selection → org default → base),
   * resolved via the same three-tier resolution PV's own visible app shell uses. `name` is `null`
   * for the base theme. This is theme *identity* only, for an extension's own returned
   * markup/copy to be theme-aware — it does NOT deliver compiled theme CSS into the sandboxed
   * iframe; that is Story 25.4's scope.
   */
  theme: {
    name: string | null
  }
  /**
   * Story 25.5 AC4/Task 1 — additive field only, `UIPanelResult` stays untouched (Story 25.5
   * AC6). The absolute path to this story's new `POST /extensions/panels/:slot/actions` route,
   * present only when the currently loaded extension declares `moduleActions` for this slot —
   * `undefined` (never `''`), not populated, when it does not, matching CM's own
   * `root.dataset.actionEndpoint` truthiness check (`if (endpoint)`) exactly. Wiring this field's
   * resolution into `resolvePanelContextAndRender()` is Story 25.5's Task 4, gated on Story
   * 25.4's `EXTENSION_PANEL_CSP`/`composePanelDocument()` landing on `main` first — the field
   * exists here now (type-level, additive, backward-compatible) but is not yet populated by any
   * caller until Task 4 lands.
   */
  actionEndpoint?: string
  /**
   * Story 25.8 AC1/Task 1 — the URL sub-path (if any) `apps/web`'s deep-linkable
   * `extensions/panels/[slot]/[...subpath]` route matched for this request, forwarded so the
   * extension can render the corresponding internal sub-state on initial load. This is PURELY
   * routing state owned by `apps/web` — the host never validates, looks up, or authorizes
   * anything about its contents (identical posture to `resourceId` above), and it is NEVER
   * concatenated into the `GET /api/v1/extensions/panels/:slot` route's own `:slot` path
   * parameter (that parameter's `knownSlots.includes(slot)` exact-match validation stays
   * untouched — see this story's Dev Notes). Present only when the matched URL actually has a
   * non-empty sub-path segment; `undefined` (never `''`) otherwise, matching `resourceId`'s own
   * documented `undefined`-vs-`''` contract.
   */
  subpath?: string
}

export type UIPanelResult = {
  /** Serializable HTML fragment for core to render into the requested slot. */
  html: string
}

export type UIPanel = {
  onRenderPanel(context: UIPanelContext): Promise<UIPanelResult>
}
