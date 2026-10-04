import type { ExtensionActionResult, ExtensionRequestContext } from './extension-request-context.js'

/**
 * Story 25.5 AC1 — an action request needs the exact same identity/org/project/locale/theme
 * context a panel render needs, no more, no less (Story 25.3's re-derivation discipline).
 *
 * Story 40.1 ADR — until this story, `ModuleActionContext` was a bare re-exported alias of
 * `UIPanelContext` (`export type ModuleActionContext = UIPanelContext`). This story splits it
 * into its own type extending `UIPanelContext` with `requestState?` instead, because the alias
 * silently implied "these two request shapes are interchangeable" — already false
 * (`moduleAction` runs inside an authenticated, in-app POST; `uiPanel` renders inside a
 * sandboxed iframe with a different security posture, per Story 25.4) and only becoming MORE
 * false as more moduleAction-only fields are added. A MINOR, additive change — TypeScript's
 * structural typing means no existing caller that merely reads fields off either type can
 * observe the split; see `module-action.test.ts`'s type-contract test proving the two types are
 * no longer structurally identical.
 *
 * Deprecated in 3.30.0 (replacement: ExtensionRequestContext). The policy-grade `@deprecated`
 * marker lives on this symbol's `src/index.ts` export; it is deliberately not repeated on this
 * declaration so the package's own internal uses do not raise deprecation diagnostics.
 */
export type ModuleActionContext = ExtensionRequestContext & {
  /** Which named panel slot the action was dispatched from (panel-only; see `UIPanelContext`). */
  slot: string
  /**
   * Panel-only: the absolute path of the panel actions route, present only when the extension
   * declares `moduleActions` for this slot (see `UIPanelContext.actionEndpoint`).
   */
  actionEndpoint?: string
  /**
   * Panel-only: the URL sub-path the deep-linkable panel route matched, `undefined` when empty
   * (see `UIPanelContext.subpath`).
   */
  subpath?: string
}

/**
 * Story 25.5 AC1 — the parsed JSON request body, verbatim. Extension-defined shape; the host does
 * not interpret any field beyond reading `kind` (AC2) to check it against the currently-loaded
 * extension's declared `moduleActions` allowlist before this ever reaches `onAction()`.
 * Deliberately type-erased beyond `kind` so no accidental structural read of a client-supplied
 * identity claim (e.g. `orgId`) can compile anywhere in the host's own routing code (AC3).
 *
 * Deprecated in 3.30.0 (replacement: composed UI (ADR 0007 build-time composition) for panel actions and M7 apiRoutes). The policy-grade `@deprecated`
 * marker lives on this symbol's `src/index.ts` export; it is deliberately not repeated on this
 * declaration so the package's own internal uses do not raise deprecation diagnostics.
 */
export type ModuleActionRequest = {
  action: Record<string, unknown> & { kind: string }
}

/**
 * Story 25.5 AC1/AC5 — mirrors the `CapabilityDecision`/`ExtensionRegistrationErrorReason`
 * typed-outcome pattern already established elsewhere in this package: a caller branches on
 * `outcome`, never on parsing a thrown error's message text.
 *
 * `error` is the degraded outcome for an unexpected/thrown failure or a timeout — the host never
 * forwards the extension's own thrown error text to the client (AC5).
 *
 * Story 59.1 — `html` is optional on EVERY outcome, not only `ok`:
 *
 * - (a) Whenever present, `html` is rendered to the end user by PV's panel host, after DOMPurify
 *   sanitization, replacing the panel container — for success and failure outcomes alike. (Older
 *   docs described `ok.html`/`ok.message` as CM's `replaceWithResponse()` success shapes; that is
 *   historical terminology — since Stories 29.1/29.2 the host-owned click handler is the consumer.)
 * - (b) A field is forwarded to the caller if and only if its published contract says it is
 *   caller-facing. `validation_failed.message` and `conflict.message` are forwarded verbatim;
 *   `denied.message` is NEVER forwarded (the caller always sees a fixed generic denial message).
 * - (c) `error.html` is shown to end users: it must never contain exception text, stack traces or
 *   database detail. PV cannot inspect or enforce this — the extension author is responsible.
 * - (d) `html` only ever comes from a result the extension explicitly RETURNS. A thrown hook, a
 *   timeout or a malformed result always degrades to a bare `{ outcome: 'error' }` with no html.
 *   A non-string `html` on any outcome makes the whole result malformed.
 * - (e) PV does not inspect, cache or re-scope `html`: the extension alone is responsible for
 *   rendering only data belonging to the request's `context.orgId`/`context.identity`.
 *
 * Deprecated in 3.30.0 (replacement: ExtensionActionResult). The policy-grade `@deprecated`
 * marker lives on this symbol's `src/index.ts` export; it is deliberately not repeated on this
 * declaration so the package's own internal uses do not raise deprecation diagnostics.
 */
export type ActionResult = ExtensionActionResult

/**
 * Deprecated in 3.30.0 (replacement: composed UI (ADR 0007 build-time composition) for panel actions and M7 apiRoutes). The policy-grade `@deprecated`
 * marker lives on this symbol's `src/index.ts` export; it is deliberately not repeated on this
 * declaration so the package's own internal uses do not raise deprecation diagnostics.
 */
export type ModuleAction = {
  onAction(context: ModuleActionContext, request: ModuleActionRequest): Promise<ActionResult>
}
