import type { FastifyBaseLogger } from 'fastify'
import { eq } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { projects, serviceEndpoints } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { ExtensionManifest, PvMonitoringHost } from '@project-vault/extension-api'
import {
  MonitoringNoAmbientContextError,
  MonitoringOrgMismatchError,
  MonitoringRateLimitedError,
  MonitoringResourceNotFoundError,
} from '@project-vault/extension-api'
import {
  applyHealthCheckResult as applyHealthCheckResultService,
  cleanupServiceEndpointsForProjectDeletion,
  deleteServiceEndpoint as deleteServiceEndpointService,
  serializeServiceEndpoint,
  updateServiceEndpoint as updateServiceEndpointService,
} from '../modules/monitoring/service.js'
import { getHealthDashboardData as getHealthDashboardDataService } from '../modules/monitoring/health-dashboard-service.js'
import {
  disableStatusPage as disableStatusPageService,
  enableStatusPage as enableStatusPageService,
  regenerateStatusPageToken as regenerateStatusPageTokenService,
} from '../modules/monitoring/status-page-service.js'
import { findProjectInOrg } from '../modules/credentials/service.js'
import { getRequestContext } from './request-context.js'
import { operationalLog } from './logger.js'

/**
 * Story 34.1 AC3(b) — a per-extension in-flight cap for the two out-of-request `monitoring`
 * methods (`applyHealthCheckResult`, `cleanupProjectMonitoring`). Distinct accounting map and
 * budget from `org-authorization.ts`'s own and `capability-gate.ts`'s own — never shared.
 */
export const MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION = 20

const monitoringHostInFlightCounts = new Map<string, number>()

function accountingKeyFor(extensionName: string): string {
  return `monitoring-host:${extensionName}`
}

function tryAcquireSlot(key: string, max: number): boolean {
  const current = monitoringHostInFlightCounts.get(key) ?? 0
  if (current >= max) return false
  monitoringHostInFlightCounts.set(key, current + 1)
  return true
}

function releaseSlot(key: string): void {
  const current = monitoringHostInFlightCounts.get(key) ?? 0
  if (current <= 1) monitoringHostInFlightCounts.delete(key)
  else monitoringHostInFlightCounts.set(key, current - 1)
}

/** Test-only introspection — never called from production code. */
export function __getMonitoringHostInFlightCountForTests(extensionName: string): number {
  return monitoringHostInFlightCounts.get(accountingKeyFor(extensionName)) ?? 0
}

/** Test-only reset — never called from production code. */
export function __resetMonitoringHostRateLimitForTests(): void {
  monitoringHostInFlightCounts.clear()
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
 */
async function callOutOfRequestMethod<T>(
  methodName: string,
  organizationId: string,
  hostContext: MonitoringHostContext,
  fn: () => Promise<T>
): Promise<T> {
  const logger = hostContext.logger ?? {}
  const accountingKey = accountingKeyFor(hostContext.extensionName)
  const maxInFlight = hostContext.maxInFlight ?? MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION

  if (!tryAcquireSlot(accountingKey, maxInFlight)) {
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
  }

  try {
    const result = await fn()
    recordMonitoringHostAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      method: methodName,
      outcome: 'ok',
    })
    return result
  } catch (error) {
    recordMonitoringHostAudit(logger, {
      extensionName: hostContext.extensionName,
      organizationId,
      method: methodName,
      outcome: 'error',
    })
    throw error
  } finally {
    releaseSlot(accountingKey)
  }
}

/** Story 34.1 AC2 — every in-request method's shared ambient-context gate: reads
 * `getRequestContext()` fresh at call time, fails closed with zero DB calls when unbound. */
function requireAmbientOrgId(methodName: string): string {
  const context = getRequestContext()
  if (!context) throw new MonitoringNoAmbientContextError(methodName)
  return context.orgId
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
  if (!row || row.orgId !== params.orgId) return null
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
      return withOrg(orgId, (tx) => getHealthDashboardDataService(tx, params?.permittedProjectIds))
    },

    async enableStatusPage(params) {
      const orgId = requireAmbientOrgId('enableStatusPage')
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
            'no such project in this org'
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
      return withOrg(orgId, (tx) => regenerateStatusPageTokenService(tx, params.projectId))
    },

    async disableStatusPage(params) {
      const orgId = requireAmbientOrgId('disableStatusPage')
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
                'no such project in this org'
              )
            }

            return cleanupServiceEndpointsForProjectDeletion(tx, {
              projectId: params.projectId,
              orgId: params.organizationId,
            })
          })
      )
    },
  }
}
