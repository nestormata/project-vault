import type { ActionResult, ModuleActionContext } from './module-action.js'

/**
 * Story 39.1 — the "extension supplies data, PV owns the actual HTTP response" mechanism an
 * OAuth-shaped connect/callback journey needs (see this story's Recommended Mechanism Decision).
 * PV's own route layer (`apps/api/src/modules/extensions/oauth-handoff-routes.ts`) is the ONLY
 * code that ever issues a real `302`/`Set-Cookie` — this hook's two methods return plain,
 * serializable data for PV to translate, mirroring `ModuleAction.onAction()`'s "PV
 * answers/dispatches, extension supplies data" shape exactly. An extension implementing this hook
 * never signs, reads, or otherwise touches a raw cookie value itself.
 */

/**
 * Story 39.1 AC1/AC9 — returned by `onOAuthStart()` to have PV issue the first, top-level redirect
 * (typically to a third-party provider's own authorize URL). `url`'s origin MUST be pre-declared
 * in the extension's manifest `redirectOrigins` allow-list (AC9) — PV rejects any URL whose origin
 * is not listed, generically, before ever issuing a redirect. `state` is a plain,
 * JSON-serializable object PV signs/stores/looks up server-side (never trusting the extension's
 * own cookie mechanics) and hands back verbatim to `onOAuthCallback()` — see this story's
 * Assumption Audit for the size cap PV enforces on it before insert.
 */
export type OAuthHandoffRedirectResult = {
  outcome: 'redirect'
  url: string
  state: Record<string, unknown>
  /**
   * Story 40.1 — when present on an `onOAuthCallback()` result ONLY, PV additionally mints a
   * SECOND, longer-lived, repeatably-readable cookie (`extension-request-state`) holding this
   * data, backed by a new `extension_request_states` row. Has NO effect when returned from
   * `onOAuthStart()` — that leg's own `state` round-trip already fully covers the short-lived,
   * single-use pending-state case Story 39.1 was built for; a `persistState` field on an
   * `onOAuthStart()` result is ignored entirely (no second cookie minted, no new DB row).
   *
   * PV validates nothing about the CONTENTS of `persistState` (same posture as `state`), but DOES
   * enforce: (a) the same `MAX_STATE_SIZE_BYTES` size cap `state` is already held to; (b) that
   * the value is JSON-serializable (a non-serializable value — e.g. a function, a circular
   * reference — is rejected the same way an oversized payload is). Either rejection leaves the
   * callback's own redirect (governed by `url`/`state`, independently validated per 39.1's
   * existing ACs) UNAFFECTED — a malformed persist leg must never break an otherwise-successful
   * OAuth journey's redirect.
   *
   * Read back later via `ModuleActionContext.requestState` (non-destructive, repeatable peek) or
   * `HostServices.extensionRequestState.consume()` (single-use, destructive read) — see
   * `hooks/module-action.ts` and `hooks/extension-request-state.ts`.
   */
  persistState?: Record<string, unknown>
}

/**
 * Story 39.1 AC1/AC2 — the two methods an `oauthHandoff` hook implementation provides. Both may
 * return either a real redirect instruction or a plain `ActionResult` (AC6) — the same
 * non-redirect outcomes `ModuleAction.onAction()` already supports (`ok`/`validation_failed`/
 * `denied`/`conflict`/`error`), reused rather than reinvented, so PV's route layer can map them
 * the same way `module-action-handler.ts`'s `isValidActionResult()` already does, extended for the
 * new redirect variant.
 */
export type OAuthHandoffHooks = {
  /**
   * Story 39.1 AC1 — invoked by PV's new, authenticated start route
   * (`POST /api/v1/extensions/oauth-handoff/start`) with the same `ModuleActionContext` shape
   * every other in-app-authenticated hook call receives. A `{outcome: 'redirect', ...}` result
   * becomes a real `302` + `Set-Cookie`; any other `ActionResult` outcome is mapped straight
   * through (AC6) with no redirect/cookie issued at all.
   */
  onOAuthStart(
    context: ModuleActionContext,
    request: { action: Record<string, unknown> & { kind: string } }
  ): Promise<OAuthHandoffRedirectResult | ActionResult>
  /**
   * Story 39.1 AC2 — invoked by PV's new, anonymous callback route
   * (`GET /api/v1/extensions/oauth-handoff/callback`, `requireAuth: false`) ONLY after PV has
   * already found and burned a matching, unexpired pending-state row for the cookie the browser
   * sent back (AC2/AC3) — `state` here is exactly the value `onOAuthStart()` supplied, recovered
   * server-side, never re-derived from anything the callback request itself carries. `query` is
   * the external provider's own raw query-string parameters (e.g. `code`/`state`/`error`)
   * forwarded verbatim.
   *
   * Deliberately does NOT receive a `ModuleActionContext` — unlike `onOAuthStart`, this route is
   * hit by an external OAuth provider with no PV session at all (AC2's whole point), so there is
   * no authenticated `identity`/`orgId` to build one from. Every fact this call needs comes from
   * `query` and the recovered `state` alone; an extension needing org/user context on the callback
   * leg must carry it itself inside `state` (e.g. the org/project id `onOAuthStart` was invoked
   * for), not expect PV to re-derive it from a nonexistent session.
   */
  onOAuthCallback(
    query: Record<string, string>,
    state: Record<string, unknown>
  ): Promise<OAuthHandoffRedirectResult | ActionResult>
}
