import type { UIPanelContext } from './ui-panel.js'

/**
 * Story 25.5 AC1 — an action request needs the exact same identity/org/project/locale/theme
 * context a panel render needs, no more, no less (Story 25.3's re-derivation discipline). Kept as
 * a plain re-exported alias, not a parallel type, so the two can never structurally drift apart.
 */
export type ModuleActionContext = UIPanelContext

/**
 * Story 25.5 AC1 — the parsed JSON request body, verbatim. Extension-defined shape; the host does
 * not interpret any field beyond reading `kind` (AC2) to check it against the currently-loaded
 * extension's declared `moduleActions` allowlist before this ever reaches `onAction()`.
 * Deliberately type-erased beyond `kind` so no accidental structural read of a client-supplied
 * identity claim (e.g. `orgId`) can compile anywhere in the host's own routing code (AC3).
 */
export type ModuleActionRequest = {
  action: Record<string, unknown> & { kind: string }
}

/**
 * Story 25.5 AC1/AC5 — mirrors the `CapabilityDecision`/`ExtensionRegistrationErrorReason`
 * typed-outcome pattern already established elsewhere in this package: a caller branches on
 * `outcome`, never on parsing a thrown error's message text.
 *
 * `ok.html`/`ok.message` map directly onto CM's real `replaceWithResponse()`'s two accepted
 * success shapes. `error` is the degraded outcome for an unexpected/thrown failure or a timeout —
 * the host never forwards the extension's own thrown error text to the client (AC5).
 */
export type ActionResult =
  | { outcome: 'ok'; html?: string; message?: string }
  | { outcome: 'validation_failed'; message: string }
  | { outcome: 'denied'; message?: string }
  | { outcome: 'conflict'; message?: string }
  | { outcome: 'error' }

export type ModuleAction = {
  onAction(context: ModuleActionContext, request: ModuleActionRequest): Promise<ActionResult>
}
