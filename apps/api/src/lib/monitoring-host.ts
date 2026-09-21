import type { FastifyBaseLogger } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { withOrg, type Tx } from '@project-vault/db'
import { projects, serviceEndpoints } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { ExtensionManifest, PvMonitoringHost } from '@project-vault/extension-api'
import {
  MonitoringInvalidServiceEndpointInputError,
  MonitoringNoAmbientContextError,
  MonitoringOrgMismatchError,
  MonitoringRateLimitedError,
  MonitoringResourceNotFoundError,
} from '@project-vault/extension-api'
import {
  applyHealthCheckResult as applyHealthCheckResultService,
  cleanupServiceEndpointsForProjectDeletion,
  createServiceEndpoint as createServiceEndpointService,
  deleteServiceEndpoint as deleteServiceEndpointService,
  listServiceEndpointsForOrg as listServiceEndpointsForOrgService,
  serializeServiceEndpoint,
  updateServiceEndpoint as updateServiceEndpointService,
} from '../modules/monitoring/service.js'
import { CreateServiceEndpointBodySchema } from '../modules/monitoring/schema.js'
import { getHealthDashboardData as getHealthDashboardDataService } from '../modules/monitoring/health-dashboard-service.js'
import {
  disableStatusPage as disableStatusPageService,
  enableStatusPage as enableStatusPageService,
  regenerateStatusPageToken as regenerateStatusPageTokenService,
} from '../modules/monitoring/status-page-service.js'
import { findProjectInOrg } from '../modules/credentials/service.js'
import { getRequestContext } from './request-context.js'
import { operationalLog } from './logger.js'
import {
  callOutOfRequestHostMethod,
  createInFlightSlotAccounting,
} from './out-of-request-host-wrapper.js'

/**
 * Story 34.1 AC3(b) — a per-extension in-flight cap for the two out-of-request `monitoring`
 * methods (`applyHealthCheckResult`, `cleanupProjectMonitoring`). Distinct accounting map and
 * budget from `org-authorization.ts`'s own and `capability-gate.ts`'s own — never shared.
 *
 * Story 58.2 Task 2 — accounting itself now lives in the shared
 * `createInFlightSlotAccounting('monitoring-host')` instance (`out-of-request-host-wrapper.ts`),
 * extracted verbatim from this file's own former `Map`-based implementation. The namespace
 * `'monitoring-host'` is distinct from `notification-originator-host.ts`'s own namespace, and the
 * shared factory's own runtime guard throws if either namespace is ever reused.
 */
export const MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION = 20

const monitoringHostAccounting = createInFlightSlotAccounting('monitoring-host')

/** Test-only introspection — never called from production code. */
export function __getMonitoringHostInFlightCountForTests(extensionName: string): number {
  return monitoringHostAccounting.getCount(extensionName)
}

/** Test-only reset — never called from production code. */
export function __resetMonitoringHostRateLimitForTests(): void {
  monitoringHostAccounting.reset()
}

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

export type MonitoringHostContext = {
  /** Identifies the loaded extension's own accounting bucket — never shared across extensions,
   * never `orgAuthorization`'s/`capability-gate.ts`'s own budget. */
  extensionName: string
  logger?: AuditLogger
  /** Test-only override of the per-extension in-flight cap. */
  maxInFlight?: number
}

/**
 * Story 34.1 AC3(c) — structured audit-log entry recorded on EVERY call to the two out-of-request
 * `monitoring` methods (success, denial, or error). Fields are `organizationId`/`extensionName`/
 * `method`/`outcome` only — never full resource content, never a probe target URL.
 */
function recordMonitoringHostAudit(
  logger: AuditLogger,
  fields: { extensionName: string; organizationId: string; method: string; outcome: string }
): void {
  try {
    operationalLog(
      logger,
      'info',
      OperationalEvent.MONITORING_HOST_CHECK_RECORDED,
      'HostServices.monitoring out-of-request call recorded',
      fields
    )
  } catch {
    // Never let an audit-logging failure surface to the caller.
  }
}

/**
 * Story 34.1 AC3 — wraps an out-of-request `monitoring` method call with (a) per-extension
 * rate-limiting via a distinct in-flight budget and (b) a structured audit-log entry recorded on
 * every outcome (success, denial, or error). `methodName` and `organizationId` are logged;
 * `organizationId` is the caller-supplied value even on a rejection, so a mismatch/denial is still
 * traceable to the org the caller claimed.
 *
 * Story 58.2 Task 2 — now a thin wrapper around the shared `callOutOfRequestHostMethod<T>`
 * (`out-of-request-host-wrapper.ts`), wiring monitoring's own `onDenied` (warn-log +
 * `recordMonitoringHostAudit(..., outcome: 'rate-limited')` + `throw new
 * MonitoringRateLimitedError`) and `onOutcome` (`recordMonitoringHostAudit` with the
 * `method`-keyed field shape). `classifyOutcome` is wired explicitly to `() => 'error'` — matching
 * the shared default, but written out so a future reader sees the flat classification is an
 * intentional, named choice for this host, not an oversight or a missed default (Design Decision
 * 1 / Elicitation Finding 1).
 */
async function callOutOfRequestMethod<T>(
  methodName: string,
  organizationId: string,
  hostContext: MonitoringHostContext,
  fn: () => Promise<T>
): Promise<T> {
  const logger = hostContext.logger ?? {}
  const maxInFlight = hostContext.maxInFlight ?? MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION

  return callOutOfRequestHostMethod({
    accounting: monitoringHostAccounting,
    extensionName: hostContext.extensionName,
    maxInFlight,
    onDenied: () => {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.MONITORING_HOST_RATE_LIMITED,
        `monitoring.${methodName}() call denied without invoking resolution — extension at its in-flight cap`,
        { extensionName: hostContext.extensionName }
      )
      recordMonitoringHostAudit(logger, {
        extensionName: hostContext.extensionName,
        organizationId,
        method: methodName,
        outcome: 'rate-limited',
      })
      throw new MonitoringRateLimitedError(methodName)
    },
    onOutcome: (outcome) => {
      recordMonitoringHostAudit(logger, {
        extensionName: hostContext.extensionName,
        organizationId,
        method: methodName,
        outcome,
      })
    },
    classifyOutcome: () => 'error',
    fn,
  })
}

/** Story 34.1 AC2 — every in-request method's shared ambient-context gate: reads
 * `getRequestContext()` fresh at call time, fails closed with zero DB calls when unbound. */
function requireAmbientOrgId(methodName: string): string {
  const context = getRequestContext()
  if (!context) throw new MonitoringNoAmbientContextError(methodName)
  return context.orgId
}

/** Shared rejection message for every `MonitoringResourceNotFoundError` thrown when a supplied
 * `projectId` does not resolve to a project within the relevant org (ambient or explicit). */
const NO_SUCH_PROJECT_IN_ORG_MESSAGE = 'no such project in this org'

/**
 * Story 41.2 AC1 — the single required-then-format check every identity/routing field (never a
 * body field) goes through: a missing/empty/non-string value is "required", a non-empty string
 * that fails `z.uuid()` is "must be a valid UUID". Shared by `validateIdentityUuids` (object
 * fields) and `validateIdentityUuidArray` (array elements, AC4) so the underlying check itself is
 * never duplicated — only this one place would need to change if the UUID format rule ever did.
 */
function checkIdentityUuidValue(
  fieldName: string,
  value: string | undefined
): { path: string[]; message: string } | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { path: [fieldName], message: `${fieldName} is required` }
  }
  if (!z.uuid().safeParse(value).success) {
    return { path: [fieldName], message: `${fieldName} must be a valid UUID` }
  }
  return null
}

/**
 * Story 41.2 AC1 — extracted from `createServiceEndpoint`'s own Story 41.1 code-review fix
 * (originally inline at this file's `createServiceEndpoint`, lines 425-438 before this refactor)
 * so every in-request method's identity/routing fields (`projectId`, `serviceEndpointId`,
 * `userId` — never a body field) get the same UUID-format check before any DB call, without
 * re-duplicating the check six more times (which would trip `pnpm jscpd`'s zero-clones gate).
 * Iterates `fields` in insertion order (JS preserves string-key insertion order), collecting
 * *every* issue rather than stopping at the first, and throws once at the end so a caller with
 * multiple malformed fields sees all of them in one `MonitoringInvalidServiceEndpointInputError`.
 */
function validateIdentityUuids(fields: Record<string, string | undefined>): void {
  const issues: { path: string[]; message: string }[] = []
  for (const [fieldName, value] of Object.entries(fields)) {
    const issue = checkIdentityUuidValue(fieldName, value)
    if (issue) issues.push(issue)
  }
  if (issues.length > 0) {
    throw new MonitoringInvalidServiceEndpointInputError(issues)
  }
}

/**
 * Story 41.2 AC4 — array-aware sibling of `validateIdentityUuids` for `getHealthDashboardData`'s
 * optional `permittedProjectIds`. `undefined` is a no-op (AC5 of Story 34.1: "no filter" must
 * keep meaning exactly that); a defined array (including `[]`, which is also a no-op here — its
 * own "nothing permitted" short-circuit is unaffected since there is nothing to iterate) is
 * checked element-by-element with index-qualified paths (`[fieldName, String(index)]`) so a
 * malformed element's position is never lost.
 */
function validateIdentityUuidArray(fieldName: string, values: string[] | undefined): void {
  if (values === undefined) return
  const issues: { path: string[]; message: string }[] = []
  values.forEach((value, index) => {
    const issue = checkIdentityUuidValue(`${fieldName}[${index}]`, value)
    if (issue) issues.push({ path: [fieldName, String(index)], message: issue.message })
  })
  if (issues.length > 0) {
    throw new MonitoringInvalidServiceEndpointInputError(issues)
  }
}

type ServiceEndpointRow = typeof serviceEndpoints.$inferSelect

/**
 * Story 34.1 AC7 — re-fetches the endpoint's full authoritative row from the database itself
 * (scoped by org id + endpoint id, inside the caller's own transaction) rather than trusting any
 * caller-supplied internal field. Returns `null` when no row matches (covers both "the org id is
 * simply wrong" and "the endpoint id belongs to a different org" — both already ruled out
 * structurally by the `eq(orgId, ...)` filter, never relying on RLS alone).
 */
async function fetchAuthoritativeServiceEndpoint(
  tx: Tx,
  params: { id: string; orgId: string }
): Promise<ServiceEndpointRow | null> {
  const [row] = await tx
    .select()
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.id, params.id))
    .limit(1)
  if (row?.orgId !== params.orgId) return null
  return row
}

/**
 * Story 34.1 — the real `HostServices.monitoring` implementation, bound to the loading
 * extension's own manifest by `loader.ts`'s `buildHostServices()`. Every method is a thin
 * closure over PV's real Epic 6 monitoring service-layer functions (AC4) — no parallel
 * reimplementation of CRUD, health-check application, alert transitions, or status-page logic.
 */
export function buildMonitoringHost(
  manifest: ExtensionManifest,
  logger: AuditLogger = {},
  /** Test-only override seam (e.g. a lowered `maxInFlight` to exercise the rate-limit path
   * deterministically) — never used in production wiring. */
  overrides: { maxInFlight?: number } = {}
): PvMonitoringHost {
  const hostContext: MonitoringHostContext = {
    extensionName: manifest.name,
    logger,
    ...(overrides.maxInFlight !== undefined ? { maxInFlight: overrides.maxInFlight } : {}),
  }

  return {
    async deleteServiceEndpoint(params) {
      const orgId = requireAmbientOrgId('deleteServiceEndpoint')
      validateIdentityUuids({
        serviceEndpointId: params.serviceEndpointId,
        projectId: params.projectId,
      })
      return withOrg(orgId, async (tx) => {
        const deleted = await deleteServiceEndpointService(tx, {
          serviceEndpointId: params.serviceEndpointId,
          projectId: params.projectId,
          orgId,
        })
        return deleted ? serializeServiceEndpoint(deleted) : null
      })
    },

    async updateServiceEndpointPauseState(params) {
      const orgId = requireAmbientOrgId('updateServiceEndpointPauseState')
      validateIdentityUuids({
        serviceEndpointId: params.serviceEndpointId,
        projectId: params.projectId,
        userId: params.userId,
      })
      return withOrg(orgId, async (tx) => {
        const result = await updateServiceEndpointService(tx, {
          serviceEndpointId: params.serviceEndpointId,
          projectId: params.projectId,
          userId: params.userId,
          body: { healthCheckPaused: params.paused },
          rawBody: { healthCheckPaused: params.paused },
        })
        if (!result) return null
        return {
          row: serializeServiceEndpoint(result.row),
          pauseTransition: result.pauseTransition,
        }
      })
    },

    async getHealthDashboardData(params) {
      const orgId = requireAmbientOrgId('getHealthDashboardData')
      validateIdentityUuidArray('permittedProjectIds', params?.permittedProjectIds)
      return withOrg(orgId, (tx) => getHealthDashboardDataService(tx, params?.permittedProjectIds))
    },

    async enableStatusPage(params) {
      const orgId = requireAmbientOrgId('enableStatusPage')
      validateIdentityUuids({ projectId: params.projectId, userId: params.userId })
      return withOrg(orgId, async (tx) => {
        // Story 34.1 AC2 tenant-isolation fix (found via real-Postgres integration testing):
        // unlike regenerateStatusPageToken/disableStatusPage — which only ever touch a
        // PRE-EXISTING status_pages row and are therefore already protected by that table's own
        // RLS policy (`org_id = current_org_id`) — enableStatusPage performs a fresh INSERT.
        // status_pages' RLS policy has no WITH CHECK tying project_id's own orgId to the new
        // row's org_id, only a FK ensuring the project exists AT ALL (in any org). Without this
        // explicit check, an ambient-org-A caller could enable a public status page (org_id: A)
        // pointing at a real projectId belonging to org B — exposing org B's service statuses
        // through a status page org A controls. Mirrors status-page-routes.ts's own
        // `findProjectInOrg` preflight, which every native HTTP route already applies before
        // calling this same service function.
        if (!(await findProjectInOrg(tx, params.projectId))) {
          throw new MonitoringResourceNotFoundError(
            'enableStatusPage',
            NO_SUCH_PROJECT_IN_ORG_MESSAGE
          )
        }
        return enableStatusPageService(tx, {
          orgId,
          projectId: params.projectId,
          userId: params.userId,
        })
      })
    },

    async regenerateStatusPageToken(params) {
      const orgId = requireAmbientOrgId('regenerateStatusPageToken')
      validateIdentityUuids({ projectId: params.projectId })
      return withOrg(orgId, (tx) => regenerateStatusPageTokenService(tx, params.projectId))
    },

    async disableStatusPage(params) {
      const orgId = requireAmbientOrgId('disableStatusPage')
      validateIdentityUuids({ projectId: params.projectId })
      return withOrg(orgId, async (tx) => {
        const result = await disableStatusPageService(tx, params.projectId)
        return result ? { statusPageId: result.statusPageId } : null
      })
    },

    async applyHealthCheckResult(params) {
      // Guard against malformed/incomplete params (e.g. a missing `serviceEndpoint`) BEFORE
      // dereferencing any nested field. Without this, a bad caller triggers a raw TypeError here
      // that bypasses both the rate-limit accounting and the audit log entirely — undermining
      // AC3(c)'s guarantee that every call (success, denial, or error) is structurally
      // audit-logged. Treated as the same `MonitoringOrgMismatchError` denial as an actual
      // org/resource mismatch, since "no comparable resource was supplied" is a strict subset of
      // "the supplied resource doesn't match."
      if (!params?.serviceEndpoint || params.serviceEndpoint.orgId !== params.organizationId) {
        recordMonitoringHostAudit(logger, {
          extensionName: manifest.name,
          organizationId: params?.organizationId ?? 'unknown',
          method: 'applyHealthCheckResult',
          outcome: 'org-mismatch-denied',
        })
        throw new MonitoringOrgMismatchError('applyHealthCheckResult')
      }

      return callOutOfRequestMethod(
        'applyHealthCheckResult',
        params.organizationId,
        hostContext,
        () =>
          withOrg(params.organizationId, async (tx) => {
            const authoritative = await fetchAuthoritativeServiceEndpoint(tx, {
              id: params.serviceEndpoint.id,
              orgId: params.organizationId,
            })
            if (!authoritative) {
              throw new MonitoringResourceNotFoundError(
                'applyHealthCheckResult',
                'no such service endpoint in this org'
              )
            }

            const result = await applyHealthCheckResultService(tx, {
              serviceEndpoint: authoritative,
              isHealthy: params.isHealthy,
              statusCode: params.statusCode,
              latencyMs: params.latencyMs,
              failureReason: params.failureReason,
              checkedAt: params.checkedAt ? new Date(params.checkedAt) : undefined,
            })

            return {
              alertFired: result.alertFired,
              episodeKey: result.episodeKey,
              updatedRow: serializeServiceEndpoint(result.updatedRow),
            }
          })
      )
    },

    async cleanupProjectMonitoring(params) {
      // Same audit-integrity guard as `applyHealthCheckResult` above: `params.organizationId` is
      // read here, before `callOutOfRequestMethod` runs, so a missing/malformed `params` object
      // must not be allowed to throw here directly — that would skip both the rate-limit
      // accounting and the audit log for this call, contradicting AC3(c).
      if (!params?.organizationId || !params.projectId) {
        recordMonitoringHostAudit(logger, {
          extensionName: manifest.name,
          organizationId: params?.organizationId ?? 'unknown',
          method: 'cleanupProjectMonitoring',
          outcome: 'invalid-params-denied',
        })
        throw new MonitoringResourceNotFoundError(
          'cleanupProjectMonitoring',
          'organizationId and projectId are required'
        )
      }

      return callOutOfRequestMethod(
        'cleanupProjectMonitoring',
        params.organizationId,
        hostContext,
        () =>
          withOrg(params.organizationId, async (tx) => {
            const [projectRow] = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.id, params.projectId))
              .limit(1)
            if (!projectRow) {
              throw new MonitoringResourceNotFoundError(
                'cleanupProjectMonitoring',
                NO_SUCH_PROJECT_IN_ORG_MESSAGE
              )
            }

            return cleanupServiceEndpointsForProjectDeletion(tx, {
              projectId: params.projectId,
              orgId: params.organizationId,
            })
          })
      )
    },

    async createServiceEndpoint(params) {
      const orgId = requireAmbientOrgId('createServiceEndpoint')

      // Story 41.1 AC3 — reuses `CreateServiceEndpointBodySchema` (the same schema applied at
      // the HTTP boundary) BEFORE any DB call, converting a validation failure into a
      // distinguishable, hook-specific error class rather than letting a raw `ZodError` or an
      // unclassified Postgres CHECK-constraint violation leak across the extension-api boundary.
      // Catches `z.ZodError` specifically (never a blanket `catch`) so a genuine bug elsewhere in
      // this block is never misreported as a user-input validation failure.
      let body: ReturnType<typeof CreateServiceEndpointBodySchema.parse>
      try {
        body = CreateServiceEndpointBodySchema.parse({
          name: params.name,
          url: params.url,
          checkFrequencyMinutes: params.checkFrequencyMinutes,
          downThresholdFailures: params.downThresholdFailures,
        })
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new MonitoringInvalidServiceEndpointInputError(
            error.issues.map((issue) => ({
              path: issue.path.map((segment) =>
                typeof segment === 'symbol' ? String(segment) : segment
              ),
              message: issue.message,
            }))
          )
        }
        throw error
      }

      // `userId`/`projectId` are identity/routing fields, not part of the service-endpoint body
      // schema (AC3) — `projectId`'s ownership is checked below via `findProjectInOrg` (AC4), but
      // BOTH must first be well-formed UUIDs, checked here, before any DB call. Without this, a
      // malformed value (e.g. a non-UUID string) reaches `findProjectInOrg`'s/`createServiceEndpointService`'s
      // raw SQL comparisons and surfaces as an unclassified Postgres error (a `TypeError`-shaped
      // operational failure, not a typed Monitoring error) instead of the same
      // `MonitoringInvalidServiceEndpointInputError` class AC3's own body-field validation already
      // uses. Found in code review (2026-09-17): this same gap is pre-existing on every other
      // in-request method in this file (`enableStatusPage`, `deleteServiceEndpoint`, etc., none of
      // which UUID-validate their own `projectId`/identity params) — fixed here for
      // `createServiceEndpoint` only, per this story's own scope; the identical fix across the
      // other six in-request methods is a separate, cross-cutting follow-up, not bundled in here.
      validateIdentityUuids({ userId: params.userId, projectId: params.projectId })

      return withOrg(orgId, async (tx) => {
        // Story 41.1 AC4 — mirrors `enableStatusPage`'s own tenant-isolation fix above:
        // `service_endpoints`' RLS policy only ties the new row's own `org_id` column to the
        // ambient org, never that the referenced `projectId` itself belongs to that org.
        if (!(await findProjectInOrg(tx, params.projectId))) {
          throw new MonitoringResourceNotFoundError(
            'createServiceEndpoint',
            NO_SUCH_PROJECT_IN_ORG_MESSAGE
          )
        }

        // Story 41.1 AC5/AC6 — thin pass-through: `ServiceEndpointLimitReachedError`/
        // `UrlNotMonitorableError` (both already thrown inside `createServiceEndpointService`
        // itself) propagate unmodified — never caught/rewrapped here.
        const row = await createServiceEndpointService(tx, {
          orgId,
          projectId: params.projectId,
          userId: params.userId,
          body,
        })
        return serializeServiceEndpoint(row)
      })
    },

    async listServiceEndpointsForScheduling(params) {
      // Story 57.1 — out-of-request (AC3), same wrapping pattern as `cleanupProjectMonitoring`
      // above: no resource-identity cross-check needed before entering the wrapper (only an
      // `organizationId` scope), unlike `applyHealthCheckResult`'s AC7 check.
      return callOutOfRequestMethod(
        'listServiceEndpointsForScheduling',
        params.organizationId,
        hostContext,
        () =>
          withOrg(params.organizationId, (tx) =>
            listServiceEndpointsForOrgService(tx, params.organizationId)
          )
      )
    },
  }
}
