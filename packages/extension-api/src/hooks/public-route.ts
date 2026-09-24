import type { ActionResult } from './module-action.js'

/**
 * Story 20.13 — generalizes `oauthHandoff.onOAuthCallback`'s "PV owns the actual HTTP
 * request/response, the extension supplies data only" shape (`hooks/oauth-handoff.ts`, line
 * 3-11) into an arbitrary-path, arbitrary-token ANONYMOUS route mechanism (Design Decision A:
 * `'public-route'` capability / `publicRoute` hook-bag key / `PublicRouteHooks` type). PV's own
 * route layer (`apps/api/src/modules/extensions/public-route-routes.ts`) is the ONLY code that
 * ever touches a real `FastifyRequest`/`FastifyReply` for this mechanism — an extension
 * implementing this hook never sees one.
 *
 * No-parallel-reimplementation note: unlike every other hook in this package, this is genuinely
 * new mechanism work, not a thin generalization of an already-shipped query/service function —
 * `oauthHandoff` is this mechanism's shape-precedent (directionality, PV-owns-the-response), but
 * its own two methods are OAuth-`state`-shaped (a pending-state cookie round trip) and are not
 * reused or wrapped here; `onPublicRouteRequest` is a materially simpler, stateless
 * request/response passthrough with no cookie/session concept at all (Design Decision C).
 *
 * Design Decision B (Nestor-confirmed) — the extension-declared `anonymousRoutePaths` manifest
 * allow-list (`manifest.ts`) is registered by PV as REAL Fastify routes at extension-load time,
 * reusing Fastify's own `find-my-way` router for path matching (literal-beats-`:param`
 * precedence included) rather than a bespoke matcher. Each declared template has AT MOST ONE
 * `:param` segment.
 *
 * Design Decision C (Nestor-confirmed) — GET-only for v1: no request body, no body-size cap.
 * `onPublicRouteRequest` has no `body?: unknown` field. A future story adding POST/body support
 * must re-open this decision's own security review (body-size cap, CSRF/anti-automation) rather
 * than silently widening scope.
 */

/**
 * Story 20.13 AC4 — returned by `onPublicRouteRequest()` to have PV issue a real, structured HTTP
 * response. `headers` is an allow-list-style plain record — PV strips `Set-Cookie` from it
 * unconditionally (no session concept exists on this anonymous path) before ever writing the real
 * response, and applies NO default/shared HTTP cache headers of its own; only cache headers the
 * extension explicitly sets here ever reach the response (Security Audit finding, Round 2). There
 * is no redirect outcome in v1 (Security Audit finding, Round 2) — `PublicRouteResult` is always a
 * structured status/headers/body instruction the extension constructs, never a raw response
 * passthrough, closing the SSRF-proxy/cache-poisoning angle considered during this story's Red
 * Team vs Blue Team elicitation round.
 */
export type PublicRouteResult = {
  outcome: 'response'
  status: number
  headers?: Record<string, string>
  body?: unknown
}

/**
 * Story 20.13 AC4 — the plain, serializable request data `onPublicRouteRequest()` receives: HTTP
 * method (always `'GET'` in v1 — Design Decision C), the exact declared path TEMPLATE this
 * request matched (e.g. `'/redeem/:token'`, never the raw request path), path params extracted by
 * Fastify's own router, and query params. Deliberately no `ModuleActionContext`, no session, no
 * raw `FastifyRequest`/`FastifyReply` — mirrors `onOAuthCallback(query, state)`'s own "no session
 * exists at this point" shape (`hooks/oauth-handoff.ts` line 78-83), simplified further since this
 * mechanism carries no recovered `state` at all.
 */
export type PublicRouteRequest = {
  method: 'GET'
  pathTemplate: string
  params: Record<string, string>
  query: Record<string, string>
}

/**
 * Story 20.13 AC1/AC4 — the single method a `publicRoute` hook implementation provides. Only
 * legal (checked by `hasCallablePublicRouteHook()`) when the manifest declares `'public-route'` in
 * `capabilities[]` and a non-empty `anonymousRoutePaths` allow-list (AC2/AC3).
 *
 * Story 59.1 — the widened `ActionResult` (optional `html` on every outcome) is reused unchanged.
 * A returned `ActionResult`'s `html` is forwarded only as an inert JSON string field of the
 * `application/json` response body (served with `nosniff`); it is never written as a document.
 */
export type PublicRouteHooks = {
  onPublicRouteRequest(request: PublicRouteRequest): Promise<PublicRouteResult | ActionResult>
}
