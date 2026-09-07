import type { AuditEventSourceHost } from './hooks/audit-event-source.js'
import type { OrgAuthorizationHost } from './hooks/org-authorization.js'
import type { EphemeralStateHost } from './hooks/ephemeral-state.js'
import type { PvMonitoringHost } from './hooks/monitoring.js'
import type { NotificationOriginatorHost } from './hooks/notification-originator.js'
import type { ProjectAuthorizationHost } from './hooks/project-authorization.js'

/**
 * Story 23.8 AC-4 — the new injected-context channel `hooksFactory()` receives at load time.
 * `hooksFactory`'s signature widens from `() => ExtensionHooks` to
 * `(host: HostServices) => ExtensionHooks` — an additive, backward-compatible change: an existing
 * extension whose `hooksFactory` declares zero parameters remains structurally assignable to the
 * new type (TypeScript parameter-count contravariance).
 *
 * Type-only export — no runtime value lives in this package (which has no DB access and must
 * never gain any). The actual `HostServices` object handed to `hooksFactory()` at runtime is
 * constructed entirely in `apps/api` (`extensions/loader.ts`'s `buildHostServices()`).
 */
export type HostServices = {
  auditEventSource: AuditEventSourceHost
  orgAuthorization: OrgAuthorizationHost
  /** Story 20.8 — bound once at extension-load time (like the two fields above); its methods
   * internally resolve the current request's `orgId` via `getRequestContext()` at call time
   * rather than being reconstructed per request. See `hooks/ephemeral-state.ts`'s doc comment. */
  ephemeralState: EphemeralStateHost
  /** Story 34.1 — bound once at extension-load time, same as every field above. Six of its eight
   * methods internally resolve the current request's `orgId` via `getRequestContext()` at call
   * time; the other two take an explicit `organizationId` parameter because they run outside any
   * request lifecycle. See `hooks/monitoring.ts`'s doc comment for the full split rationale. */
  monitoring: PvMonitoringHost
  /** Story 36.1 — bound once at extension-load time, same as every field above. Its one method,
   * `enqueueNotification()`, internally resolves the current request's `orgId` via
   * `getRequestContext()` at call time. NOT gated by the unrelated `'notification-channel'`
   * `ExtensionCapability` — see `hooks/notification-originator.ts`'s doc comment for the full
   * naming-collision disambiguation. */
  notificationOriginator: NotificationOriginatorHost
  /** Story 37.1 — bound once at extension-load time, same as every field above. Its one method,
   * `checkProjectMembership()`, answers "is this identity a member of this specific project at
   * this role or above" — a project-scoped sibling of `orgAuthorization`, not an extension of it
   * (see `hooks/project-authorization.ts`'s doc comment for why a dedicated field). Reuses PV's
   * own `project_memberships`-backed `effectiveProjectRole()` semantics (org-owner/admin bypass,
   * explicit-row fallback) so its answer matches what PV's own project routes already enforce. */
  projectAuthorization: ProjectAuthorizationHost
}
