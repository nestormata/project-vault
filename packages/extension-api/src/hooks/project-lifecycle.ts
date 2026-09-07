/**
 * Host-called policy hook for project creation. PV owns the transaction, project rows,
 * memberships, tenant context, and audit write. An extension may only answer whether the
 * already-authorized PV request is allowed to create one more project.
 */
export type ProjectCreatePolicyContext = {
  organizationId: string
  actorUserId: string
  projectName: string
  currentProjectCount: number
  creationRequestId: string
}

export type ProjectCreateDecision =
  { permitted: true } | { permitted: false; reasonCode: string; message?: string }

export type ProjectCreatePolicy = {
  onBeforeCreateProject(context: ProjectCreatePolicyContext): Promise<ProjectCreateDecision>
}

/**
 * Story 35.1 — payload for `ProjectArchiveNotifier.onProjectArchived`. `organizationId`/
 * `projectId` are exactly the org/project that was archived (never another org's data, even
 * under concurrent multi-org dispatch — AC4). No "was this project already archived once before"
 * flag is carried: each archive transition gets its own independent notification (Design
 * Decision 5) — an extension whose own consumer-side logic is idempotent handles a
 * re-archived project as two independent, correct notifications, not a bug. Delivery order
 * across two DIFFERENT `ProjectArchivedContext` events for the SAME project is NOT guaranteed
 * (no FIFO promise) if more than one worker dispatcher ever runs concurrently — use each
 * notification's own `archivedAt` to detect/tolerate out-of-order delivery.
 */
export type ProjectArchivedContext = {
  organizationId: string
  projectId: string
  archivedAt: string
  archivedByUserId: string
}

/**
 * Story 35.1 — host-called NOTIFICATION hook fired after PV's own `POST /:projectId/archive`
 * transaction has already committed. Dispatched entirely out-of-request by a background worker
 * (see `apps/api/src/workers/extension-lifecycle-notify.ts`) reading a durable outbox table
 * (`extension_lifecycle_events`) — never called synchronously inside the archive route's own
 * request/response cycle.
 *
 * **Not a deletion signal.** PV's archive is non-destructive and fully reversible (see
 * `POST /:projectId/unarchive`, which leaves no tombstone) — this is a "the project left PV's
 * active set" signal, not proof the project's data is gone forever. PV does NOT call a
 * symmetric "un-notify" hook on unarchive; an extension that already resolved/cleaned up its own
 * project-scoped state in response to this hook has no PV-side signal to reverse that if the
 * project is later unarchived (an accepted, explicit scope boundary — see Story 35.1 Design
 * Decision 2). A hypothetical future hard-delete of a project would use a wholly separate
 * `onProjectDeleted`/`ProjectDeletedContext` pair — never repurpose this one for that.
 *
 * **Never a veto/policy decision, unlike `ProjectCreatePolicy`.** The extension cannot block,
 * delay past its own timeout, or roll back an archive PV has already decided (and already
 * committed) to perform — `onProjectArchived` returns `Promise<void>`, never a decision value,
 * and a thrown/rejected/hanging call can never affect PV's own archive response (the calling
 * worker is fully out-of-request).
 *
 * **At-least-once delivery, no idempotency guarantee (mirrors `AuditEventSourceHost`'s own
 * "no idempotency, caller's own responsibility" convention).** PV's worker retries on timeout or
 * thrown rejection up to a bounded attempt cap; the SAME notification (same `archivedAt`) may
 * therefore be delivered more than once. The extension's own handler must be safe to receive the
 * same notification — and, per the ordering caveat on `ProjectArchivedContext` above, a
 * different-but-related notification for the same project — more than once.
 */
export type ProjectArchiveNotifier = {
  onProjectArchived(context: ProjectArchivedContext): Promise<void>
}
