/**
 * Story 29.4 AC3 — `ModuleDataRequestContext` mirrors `UIPanelContext`'s existing identity/org
 * shape, plus `params`/`query` for the resolved route. Deliberately minimal, matching
 * `UIPanelContext`'s own "re-derived fresh from the request's own resolved session on every
 * call, never cached" discipline.
 */
export type ModuleDataRequestContext = {
  /** Story 29.4 AC3 — who is asking, re-derived fresh from the request's own resolved session. */
  identity: {
    userId: string
    orgRole: 'owner' | 'admin' | 'member' | 'viewer'
  }
  /** Story 29.4 AC3 — the caller's org, read directly from the request's resolved session. */
  orgId: string
  /**
   * Story 29.4 AC3 — the resolved `:param` values from the matched route (Fastify's own native
   * `req.params`).
   */
  params: Record<string, string>
  /**
   * Story 29.4 AC3 — the request's raw query-string values, unvalidated — same "extension's own
   * problem to validate" posture `resourceId`/`subpath` already have on the panel route.
   */
  query: Record<string, string>
}

/**
 * Story 29.4 AC3 — `status` defaults to `200` when omitted; `body` is JSON-serialized verbatim by
 * the route (mirrors `onRenderPanel()`'s own "trusted-but-arbitrary in-process code" posture — no
 * re-sanitization of the module's own returned data shape).
 */
export type ModuleDataResult = {
  status?: number
  body: unknown
}

export type ModuleDataRouteHandler = (
  context: ModuleDataRequestContext
) => Promise<ModuleDataResult>
