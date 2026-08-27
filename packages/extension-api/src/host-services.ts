import type { AuditEventSourceHost } from './hooks/audit-event-source.js'
import type { OrgAuthorizationHost } from './hooks/org-authorization.js'
import type { EphemeralStateHost } from './hooks/ephemeral-state.js'

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
}
