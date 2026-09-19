/**
 * Story 40.1 — `ExtensionRequestStateHostService` is the CONSUME leg of the request-state
 * mechanism (the PEEK leg is `ModuleActionContext.requestState`, `module-action.ts`). It does NOT
 * belong in `ExtensionHooks` — this is PV-owned, imperative, callable behavior an extension
 * invokes explicitly, delivered to the extension via `HostServices` (see `../host-services.ts`),
 * the same shape every other `HostServices` field already follows
 * (`orgAuthorization`/`monitoring`/`scheduledTasks`).
 *
 * A context field (the peek) and a `HostServices` callback (the consume) are deliberately
 * DIFFERENT shapes for the SAME underlying stored state, for opposite reasons: peeking is a pure,
 * repeatable, non-side-effecting read — exactly the "point-in-time snapshot" shape a context
 * field already exists to carry (mirrors `identity`/`orgId`/`resourceId`); consuming is a
 * one-shot, side-effecting operation an extension must explicitly and deliberately invoke, never
 * an implicit side effect of PV merely constructing a context object before `onAction()` even
 * runs (mirrors `orgAuthorization`'s "live, re-verifiable" answering-function shape). Matches
 * CM's own `peekPendingRepositorySelection`/`consumePendingRepositorySelectionRow` split
 * (`pending-selection.ts`) one-for-one.
 */
export type ExtensionRequestStateHostService = {
  /**
   * Story 40.1 AC3/AC4/AC12 — atomically consumes (single-use burn) the pending request-state
   * row for the `extension-request-state` cookie on the CURRENT request, if any, scoped to the
   * CURRENT request's `orgId`/`identity` (AC12 — a cross-org/cross-identity consume attempt
   * resolves to `undefined` and does NOT burn the row, so it can never deny service to the
   * legitimate minting org/identity).
   *
   * Returns `undefined` if there is no cookie, no matching row, an expired row, or an
   * already-consumed row — collapsed identically (AC4), mirroring 39.1 AC3's generic-rejection
   * discipline (never distinguishes WHY to the extension). Safe to call at most meaningfully once
   * per request — a second call in the same request returns `undefined` even if the first call
   * succeeded, since the row is already burned.
   */
  consume(): Promise<Record<string, unknown> | undefined>
}
