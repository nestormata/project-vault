import type { HostServices } from '../host-services.js'

/**
 * Story 56.1 AC1/AC3 — the context PV's job runner hands to a due `(org, task)` invocation.
 * Deliberately minimal and serializable-data-only per architecture.md § Data Boundaries: no `Tx`,
 * no raw DB handle, no `AuthContext` — only `organizationId`/`taskName` (plain strings) and the
 * SAME `HostServices` instance already bound for this extension at load time (see
 * `apps/api/src/extensions/loader.ts#buildHostServices`). A future PR that adds a `Tx`/raw-handle
 * field to this type "for efficiency" is a Data Boundaries violation — reject it in review exactly
 * as any other `packages/extension-api` boundary breach would be (see this story's Dev Notes AC3
 * reviewer-checklist note).
 */
export type ScheduledTaskContext = {
  organizationId: string
  taskName: string
  hostServices: HostServices
}

/**
 * Story 56.1 AC1 — a single extension-implemented dispatch target for every due `(org, task)`
 * tuple across every scheduled task the extension declares in its manifest's `scheduledTasks[]`.
 * PV distinguishes which task is due via `context.taskName`, not via separate per-task handler
 * functions (see `ScheduledTaskDeclaration.handler`'s own doc comment for why this is a single
 * literal today, not a per-task union).
 */
export type ScheduledTaskHooks = {
  onScheduledTask(context: ScheduledTaskContext): Promise<void>
}
