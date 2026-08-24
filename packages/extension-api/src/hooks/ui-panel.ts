/**
 * AC2/AC3 — `UIPanel` is one of the three typed hook interfaces this package exports.
 * Serializable-data-only render result per architecture.md § Data Boundaries — an extension
 * returns markup/data for core to render, it never receives a live DOM/component reference.
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
}

export type UIPanelResult = {
  /** Serializable HTML fragment for core to render into the requested slot. */
  html: string
}

export type UIPanel = {
  onRenderPanel(context: UIPanelContext): Promise<UIPanelResult>
}
