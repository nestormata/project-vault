/**
 * Story 34.1 — `PvMonitoringHost` is the eighth `HostServices` field (see `host-services.ts`),
 * same directionality as `AuditEventSourceHost`/`OrgAuthorizationHost`/`EphemeralStateHost`: PV
 * implements every method here and hands a bound instance to the extension via `HostServices`.
 * It does NOT belong in `ExtensionHooks` — this is PV answering/servicing the extension, not the
 * extension implementing behavior for PV.
 *
 * Named `PvMonitoringHost` (not `MonitoringHost`) specifically to avoid colliding with
 * `centralizeme-sass`'s own already-written `MonitoringHost` type name if both are ever imported
 * side-by-side (Story 34.1 AC1).
 *
 * **Org/transaction-context binding is split by invocation context (Design Decision 2), not
 * uniform across all eight methods:**
 * - The six in-request methods (`deleteServiceEndpoint`, `updateServiceEndpointPauseState`,
 *   `getHealthDashboardData`, `enableStatusPage`, `regenerateStatusPageToken`,
 *   `disableStatusPage`) resolve `orgId` ambiently via `apps/api/src/lib/request-context.ts`'s
 *   `getRequestContext()` at call time — there is structurally no `organizationId` field on any
 *   of their parameter types, mirroring `OrgAuthorizationHost`'s post-23.11 shape.
 * - The two out-of-request methods (`applyHealthCheckResult`, `cleanupProjectMonitoring`) take an
 *   explicit `organizationId` parameter because no ambient request is in flight when PV's own
 *   background health-check worker cycle or a project-deletion lifecycle event invokes them.
 *   These two are rate-limited using a distinct in-flight accounting bucket from
 *   `orgAuthorization`'s own, and every call (success, denial, or error) is structurally
 *   audit-logged.
 *
 * **No parallel reimplementation (AC4).** Every method here is a thin closure over PV's real
 * Epic 6 monitoring service-layer functions (`apps/api/src/modules/monitoring/service.ts`,
 * `health-dashboard-service.ts`, `status-page-service.ts`), wired in `apps/api/src/extensions/
 * loader.ts`'s `buildHostServices()`. `packages/extension-api` itself stays type-only/zero-DB —
 * these types describe the contract; the runtime implementation lives entirely in `apps/api`.
 *
 * **Error classes (AC6).** Errors PV's own wrapped functions already throw (e.g.
 * `StatusPageAlreadyEnabledError`, `StatusPageNotFoundError`, `InvalidServiceReferenceError` from
 * `status-page-service.ts`) propagate UNCHANGED across this hook boundary — they already carry a
 * distinct, non-message `name`/`code`, so a consumer can already tell them apart without string-
 * matching. This module adds three NEW, hook-specific error classes for the three new failure
 * modes this story itself introduces (ambient-context absence, per-extension rate-limiting, and
 * the AC7 organizationId/resource cross-check) — never a re-derivation of any PV route's own
 * authorization/validation logic.
 */

// ---------------------------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------------------------

/**
 * AC2 — thrown by every in-request method when `getRequestContext()` returns `undefined` (no
 * request context is bound). Distinct from an authorization denial: this signals "this call did
 * not run inside a request PV itself is handling," not "the identity driving this request lacks
 * permission." Zero DB calls are made before this throws.
 */
export class MonitoringNoAmbientContextError extends Error {
  readonly code = 'monitoring_no_ambient_context'

  constructor(methodName: string) {
    super(
      `HostServices.monitoring.${methodName}() was called with no ambient request context bound`
    )
    this.name = 'MonitoringNoAmbientContextError'
  }
}

/**
 * AC3(b) — thrown by `applyHealthCheckResult`/`cleanupProjectMonitoring` when the calling
 * extension's per-extension in-flight accounting key is already at its concurrency cap. This
 * budget is distinct from `orgAuthorization`'s own and from `capability-gate.ts`'s own — never
 * shared across hooks.
 */
export class MonitoringRateLimitedError extends Error {
  readonly code = 'monitoring_rate_limited'

  constructor(methodName: string) {
    super(`HostServices.monitoring.${methodName}() rejected: per-extension in-flight cap reached`)
    this.name = 'MonitoringRateLimitedError'
  }
}

/**
 * AC7 — thrown by `applyHealthCheckResult` when its explicit `organizationId` parameter disagrees
 * with the supplied `serviceEndpoint.orgId`. This is the "operational failure" error class AC6's
 * five-classes taxonomy names: fail closed, no write applied, logged as a denial — never a
 * silent pick of one value over the other.
 */
export class MonitoringOrgMismatchError extends Error {
  readonly code = 'monitoring_org_mismatch'

  constructor(methodName: string) {
    super(
      `HostServices.monitoring.${methodName}() rejected: the supplied organizationId does not match the resource's own orgId`
    )
    this.name = 'MonitoringOrgMismatchError'
  }
}

/**
 * AC7's `cleanupProjectMonitoring` edge case — thrown when the supplied `projectId` does not
 * resolve to a project within the supplied `organizationId`. This is the "missing/unauthorized
 * resource" error class AC6's taxonomy names — never a cascade applied against a foreign org's
 * project using this call's own audit trail.
 */
export class MonitoringResourceNotFoundError extends Error {
  readonly code = 'monitoring_resource_not_found'

  constructor(methodName: string, message: string) {
    super(`HostServices.monitoring.${methodName}() rejected: ${message}`)
    this.name = 'MonitoringResourceNotFoundError'
  }
}

// ---------------------------------------------------------------------------------------------
// Shared data shapes — plain, serializable mirrors of PV's own monitoring row shapes. Deliberately
// independent of `@project-vault/db`'s schema types (extension-api stays zero-DB-access) and of
// `@project-vault/shared`'s `HealthDashboard` (extension-api stays independent of that package's
// own dependency graph) — apps/api's real wiring returns values that are structurally compatible
// with these types without any adapter object being constructed.
// ---------------------------------------------------------------------------------------------

export type MonitoringServiceEndpointStatus = 'healthy' | 'degraded' | 'down'

/** Mirrors `service.ts`'s `serializeServiceEndpoint()` output exactly — `url` is already redacted
 * there (ADR-6.2-11); this hook does not additionally expose the raw URL. Deliberately omits
 * `downEpisodeStartedAt` (internal alert-continuity bookkeeping, already excluded from PV's own
 * route-facing serializer). */
export type MonitoringServiceEndpointRecord = {
  id: string
  orgId: string
  projectId: string
  name: string
  url: string
  checkFrequencyMinutes: number
  downThresholdFailures: number
  status: MonitoringServiceEndpointStatus
  consecutiveFailures: number
  lastCheckedAt: string | null
  healthCheckPaused: boolean
  healthCheckPausedAt: string | null
  healthCheckPausedBy: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export type MonitoringAlertType = 'service.down' | 'service.recovery'

export type MonitoringHealthDashboardServiceEntry = {
  id: string
  name: string
  status: MonitoringServiceEndpointStatus
  lastCheckedAt: string | null
}

export type MonitoringHealthDashboardProjectEntry = {
  projectId: string
  projectName: string
  services: MonitoringHealthDashboardServiceEntry[]
}

export type MonitoringHealthDashboardSummary = {
  healthy: number
  degraded: number
  down: number
}

/** Mirrors `health-dashboard-service.ts`'s `getHealthDashboardData()` return shape. */
export type MonitoringHealthDashboard = {
  projects: MonitoringHealthDashboardProjectEntry[]
  summary: MonitoringHealthDashboardSummary
}

// ---------------------------------------------------------------------------------------------
// In-request methods (AC2) — no organizationId/pvOrganizationId field anywhere on these
// parameter types; orgId is always resolved ambiently by the host at call time.
// ---------------------------------------------------------------------------------------------

export type MonitoringDeleteServiceEndpointParams = {
  serviceEndpointId: string
  projectId: string
}

export type MonitoringUpdateServiceEndpointPauseStateParams = {
  serviceEndpointId: string
  projectId: string
  userId: string
  paused: boolean
}

export type MonitoringUpdateServiceEndpointPauseStateResult = {
  row: MonitoringServiceEndpointRecord
  pauseTransition: 'paused' | 'resumed' | null
}

/** AC5 — `permittedProjectIds` filters the underlying query itself (never a post-filter); an
 * empty array is a real "nothing permitted" signal (an empty dashboard), never "unfiltered". */
export type MonitoringGetHealthDashboardDataParams = {
  permittedProjectIds?: string[]
}

export type MonitoringEnableStatusPageParams = {
  projectId: string
  userId: string
}

export type MonitoringEnableStatusPageResult = {
  id: string
  token: string
  createdAt: string
}

export type MonitoringRegenerateStatusPageTokenParams = {
  projectId: string
}

export type MonitoringRegenerateStatusPageTokenResult = {
  id: string
  token: string
  updatedAt: string
}

export type MonitoringDisableStatusPageParams = {
  projectId: string
}

/** Design Decision 6 — narrows `status-page-service.ts`'s real `{ statusPageId, snapshot }`
 * return shape, intentionally dropping `snapshot` (no known consumer need for it today). */
export type MonitoringDisableStatusPageResult = {
  statusPageId: string
}

// ---------------------------------------------------------------------------------------------
// Out-of-request methods (AC3) — explicit organizationId, rate-limited, structurally audited.
// ---------------------------------------------------------------------------------------------

/**
 * AC7 — `serviceEndpoint` carries only the identity fields this hook needs to (a) look the
 * endpoint up and (b) cross-check against the caller's own `organizationId` BEFORE any DB read.
 * The host re-fetches the endpoint's full authoritative row (internal fields included) from the
 * database itself inside the same transaction — it never trusts a caller-supplied internal
 * field (e.g. consecutiveFailures, downEpisodeStartedAt) for the write it is about to perform.
 */
export type MonitoringApplyHealthCheckResultParams = {
  organizationId: string
  serviceEndpoint: { id: string; orgId: string }
  isHealthy: boolean
  statusCode: number | null
  latencyMs: number
  failureReason: 'timeout' | 'http_error' | 'network_error' | 'ssrf_blocked' | null
  /** ISO-8601 string — the host converts to a `Date` internally. Omit to use the current time. */
  checkedAt?: string
}

export type MonitoringApplyHealthCheckResultResult = {
  alertFired: MonitoringAlertType | null
  episodeKey: string | null
  updatedRow: MonitoringServiceEndpointRecord
}

export type MonitoringCleanupProjectMonitoringParams = {
  organizationId: string
  projectId: string
}

export type MonitoringCleanupProjectMonitoringResult = {
  resolvedAlertCount: number
}

/**
 * Story 34.1 — the real `HostServices.monitoring` field. See this module's doc comment for the
 * full directionality/error-class/org-scoping rationale.
 */
export type PvMonitoringHost = {
  deleteServiceEndpoint(
    params: MonitoringDeleteServiceEndpointParams
  ): Promise<MonitoringServiceEndpointRecord | null>
  updateServiceEndpointPauseState(
    params: MonitoringUpdateServiceEndpointPauseStateParams
  ): Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>
  getHealthDashboardData(
    params?: MonitoringGetHealthDashboardDataParams
  ): Promise<MonitoringHealthDashboard>
  enableStatusPage(
    params: MonitoringEnableStatusPageParams
  ): Promise<MonitoringEnableStatusPageResult>
  regenerateStatusPageToken(
    params: MonitoringRegenerateStatusPageTokenParams
  ): Promise<MonitoringRegenerateStatusPageTokenResult>
  disableStatusPage(
    params: MonitoringDisableStatusPageParams
  ): Promise<MonitoringDisableStatusPageResult | null>
  applyHealthCheckResult(
    params: MonitoringApplyHealthCheckResultParams
  ): Promise<MonitoringApplyHealthCheckResultResult>
  cleanupProjectMonitoring(
    params: MonitoringCleanupProjectMonitoringParams
  ): Promise<MonitoringCleanupProjectMonitoringResult>
}
