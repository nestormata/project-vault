/**
 * Story 68.11 AC-2 (Q3) — the neutral, panel-free request context handed to the non-deprecated
 * `oauthHandoff` hook (`onOAuthStart`) and usable by any extension code that needs "who is asking
 * and for which org/project" without the legacy UI-panel vocabulary.
 *
 * It is the SUPERTYPE of the deprecated `ModuleActionContext`: `ModuleActionContext` keeps its exact
 * current members (it adds only the panel-only `slot`, `actionEndpoint` and `subpath`), so every
 * 3.x extension still type-checks, and a handler written against this type is assignable to a hook
 * slot still typed with `ModuleActionContext` (parameter contravariance). It deliberately has NO
 * `slot`, `actionEndpoint` or `subpath`. The host-built context for `oauthHandoff` still carries a
 * `slot` value in this release; do not read it.
 *
 * Every member keeps the meaning documented on the legacy types: `identity` is re-derived from the
 * request's own resolved session (never a client claim), `orgId` is read from that session,
 * `projectId` is present only when the caller may see that project, `locale` and `theme` are
 * resolved server-side, and `resourceId` is passed through verbatim with no PV-side lookup.
 */
export type ExtensionRequestContext = {
  /**
   * Optional, extension-owned resource identifier. Shape-validated by the host, passed through
   * verbatim with NO PV-side lookup, membership check or existence check: the extension is solely
   * responsible for authorizing whatever it identifies.
   */
  resourceId?: string
  /**
   * Who is asking, for personalization. Deliberately minimal: re-derived fresh from the request's
   * own resolved session on every call, never cached across requests. `sessionId`, `jti`,
   * `sessionVersion` and `isPlatformOperator` are deliberately excluded. A point-in-time snapshot,
   * not a live credential: gate a specific mutation with
   * `HostServices.orgAuthorization.checkMembership`, not with this context alone.
   */
  identity: {
    userId: string
    orgRole: 'owner' | 'admin' | 'member' | 'viewer'
  }
  /** The caller's org, read directly from the request's resolved session. */
  orgId: string
  /**
   * Optional, populated only when the client supplies a `?projectId=` query parameter AND the
   * caller is authorized to see that project. An unauthorized or nonexistent `projectId` never
   * reaches this context.
   */
  projectId?: string
  /** Resolved server-side from the caller's stored locale preference, never a client value. */
  locale: 'en' | 'es'
  /** Machine-readable theme identity (`name` is `null` for the base theme). */
  theme: {
    name: string | null
  }
  /**
   * Story 40.1 — present only when the inbound request carries PV's `extension-request-state`
   * cookie AND a matching, unexpired, unconsumed row exists for the currently loaded extension,
   * scoped to the CURRENT request's `orgId`/`identity` (a hash match against a row minted under a
   * different org/identity resolves to `undefined`). Non-destructive: reading it never consumes
   * the underlying row, so it is repeatable across requests within the row's TTL. A point-in-time
   * snapshot computed once at context-build time, before the hook runs. PV validates nothing about
   * the CONTENTS of this value; the extension alone interprets it.
   */
  requestState?: Record<string, unknown>
}

/**
 * Story 68.11 AC-2 (Q3/Q4) — the typed-outcome result an `oauthHandoff` or `publicRoute` hook may
 * return instead of a redirect/response instruction. This is the same union the deprecated
 * `ActionResult` alias names. A caller branches on `outcome`, never on parsing error text.
 *
 * - `error` is the degraded outcome for an unexpected/thrown failure or a timeout; the host never
 *   forwards the extension's own thrown error text to the client.
 * - `validation_failed.message` and `conflict.message` are forwarded verbatim; `denied.message` is
 *   NEVER forwarded (the caller always sees a fixed generic denial message).
 * - `html` is optional on every outcome. On `oauthHandoff` and `publicRoute` results it is
 *   forwarded only as an inert JSON string field; PV does not render it there. It only ever comes
 *   from a result the extension explicitly RETURNS (a thrown hook, a timeout or a malformed result
 *   degrades to a bare `{ outcome: 'error' }`), and a non-string `html` makes the whole result
 *   malformed. PV does not inspect, cache or re-scope it: the extension alone is responsible for
 *   never putting exception text, stack traces or another org's data in it.
 */
export type ExtensionActionResult =
  | { outcome: 'ok'; html?: string; message?: string }
  | { outcome: 'validation_failed'; message: string; html?: string }
  | { outcome: 'denied'; message?: string; html?: string }
  | { outcome: 'conflict'; message?: string; html?: string }
  | { outcome: 'error'; html?: string }
