import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  paymentRecords,
  certRecords,
  domainRecords,
  notificationQueue,
  serviceEndpoints,
  endpointHealthChecks,
  monitoringAlerts,
} from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import {
  assertUrlIsMonitorable,
  redactUrlForDisplay,
  UrlNotMonitorableError,
} from './url-safety.js'
import {
  computeStatusTransition,
  episodeKeyFor,
  type MonitoringAlertType,
} from '../../workers/monitoring-alert-shared.js'
import type {
  CreateCertificateBody,
  CreateDomainRecordBody,
  CreatePaymentRecordBody,
  CreateServiceEndpointBody,
  UpdateCertificateBody,
  UpdateDomainRecordBody,
  UpdatePaymentRecordBody,
  UpdateServiceEndpointBody,
  HealthHistoryQuery,
  AlertListQuery,
} from './schema.js'

export const PAYMENT_DEFAULT_ALERT_LEAD_DAYS = [14, 3]
export const CERTIFICATE_DEFAULT_ALERT_LEAD_DAYS = [30, 7]
export const DOMAIN_DEFAULT_ALERT_LEAD_DAYS = [30]

export { UrlNotMonitorableError }

/**
 * AC 7: deleting a service/certificate/domain record must cancel any notifications still
 * queued for it (a hard delete leaves nothing else to point the notification at). A plain
 * `payload->>'assetId'` match is fine here — no index is required for the low pending-row
 * cardinality per org (see story AC 7 note).
 */
export async function suppressPendingNotificationsForAsset(
  tx: Tx,
  params: { orgId: string; assetId: string }
): Promise<void> {
  await tx
    .update(notificationQueue)
    .set({ status: 'suppressed' })
    .where(
      and(
        eq(notificationQueue.orgId, params.orgId),
        eq(notificationQueue.status, 'pending'),
        sql`${notificationQueue.payload}->>'assetId' = ${params.assetId}`
      )
    )
}

/**
 * AC 6: writing a new expiry/renewal date resets the alert cycle — only when the request body
 * actually included that field (distinguishes "explicitly cleared" from "not sent").
 */
function applyDateReset(
  updates: Record<string, unknown>,
  dateField: string,
  rawBody: Record<string, unknown>,
  newValue: string | null | undefined
): void {
  if (!(dateField in rawBody)) return
  updates[dateField] = newValue ? new Date(newValue) : null
  updates.notifiedLeadDays = []
}

/**
 * Builds the Drizzle `.set()` payload for a monitoring-record PATCH: copies the one asset-
 * specific text field (`url`/`domain`/`domainName`) plus alertLeadDays when the request body
 * included them, and applies the AC 6 date-reset (see `applyDateReset`) for the expiry/renewal
 * date field. Shared across payment/certificate/domain since the shape is identical and only
 * the field *names* differ.
 */
function buildMonitoringUpdates(
  rawBody: Record<string, unknown>,
  simpleField: { key: string; value: unknown },
  dateField: { key: string; value: string | null | undefined },
  alertLeadDays: number[] | undefined
): Record<string, unknown> {
  const updates: Record<string, unknown> = {}
  if (simpleField.key in rawBody) updates[simpleField.key] = simpleField.value
  applyDateReset(updates, dateField.key, rawBody, dateField.value)
  if ('alertLeadDays' in rawBody) updates.alertLeadDays = alertLeadDays
  return updates
}

/**
 * Applies a built `updates` payload, or falls back to a plain read when it's empty (AC 6):
 * an empty request body must not hand Drizzle an invalid `.set({})` with zero assignments.
 * Still 404s via the caller (through `onNoop`) if the row isn't found.
 */
async function applyMonitoringUpdate<Row>(
  updates: Record<string, unknown>,
  onNoop: () => Promise<Row | null>,
  onUpdate: (updates: Record<string, unknown>) => Promise<Row | null>
): Promise<Row | null> {
  if (Object.keys(updates).length === 0) return onNoop()
  return onUpdate(updates)
}

// --- Serializers ---

/** Identity + audit-tail fields shared by every monitoring-record serializer. */
function baseRecordFields(row: {
  id: string
  orgId: string
  projectId: string
  alertLeadDays: number[]
  notifiedLeadDays: number[]
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    alertLeadDays: row.alertLeadDays,
    notifiedLeadDays: row.notifiedLeadDays,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializePaymentRecord(row: typeof paymentRecords.$inferSelect) {
  return {
    ...baseRecordFields(row),
    name: row.name,
    url: row.url,
    renewalDate: row.renewalDate?.toISOString() ?? null,
  }
}

export function serializeCertificateRecord(row: typeof certRecords.$inferSelect) {
  return {
    ...baseRecordFields(row),
    domain: row.domain,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}

export function serializeDomainRecord(row: typeof domainRecords.$inferSelect) {
  return {
    ...baseRecordFields(row),
    domainName: row.domainName,
    renewalDate: row.renewalDate?.toISOString() ?? null,
  }
}

// --- Services (payment_records) ---

export async function listPaymentRecords(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(paymentRecords)
    .where(eq(paymentRecords.projectId, projectId))
    .orderBy(paymentRecords.createdAt)
  return rows.map(serializePaymentRecord)
}

export async function createPaymentRecord(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreatePaymentRecordBody }
) {
  const [row] = await tx
    .insert(paymentRecords)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.body.name,
      url: input.body.url ?? null,
      renewalDate: input.body.renewalDate ? new Date(input.body.renewalDate) : null,
      alertLeadDays: input.body.alertLeadDays ?? PAYMENT_DEFAULT_ALERT_LEAD_DAYS,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Payment record insert returned no row')
  return row
}

export async function findPaymentRecordInProject(
  tx: Tx,
  params: { serviceId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(paymentRecords)
    .where(
      and(eq(paymentRecords.id, params.serviceId), eq(paymentRecords.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export async function updatePaymentRecord(
  tx: Tx,
  input: {
    serviceId: string
    projectId: string
    body: UpdatePaymentRecordBody
    rawBody: Record<string, unknown>
  }
) {
  const updates = buildMonitoringUpdates(
    input.rawBody,
    { key: 'url', value: input.body.url ?? null },
    { key: 'renewalDate', value: input.body.renewalDate },
    input.body.alertLeadDays
  )

  return applyMonitoringUpdate(
    updates,
    () =>
      findPaymentRecordInProject(tx, { serviceId: input.serviceId, projectId: input.projectId }),
    async (setValues) => {
      const [updated] = await tx
        .update(paymentRecords)
        .set(setValues)
        .where(
          and(eq(paymentRecords.id, input.serviceId), eq(paymentRecords.projectId, input.projectId))
        )
        .returning()
      return updated ?? null
    }
  )
}

export async function deletePaymentRecord(
  tx: Tx,
  params: { serviceId: string; projectId: string }
) {
  const [deleted] = await tx
    .delete(paymentRecords)
    .where(
      and(eq(paymentRecords.id, params.serviceId), eq(paymentRecords.projectId, params.projectId))
    )
    .returning()
  return deleted ?? null
}

// --- Certificates (cert_records) ---

export async function listCertificateRecords(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(certRecords)
    .where(eq(certRecords.projectId, projectId))
    .orderBy(certRecords.createdAt)
  return rows.map(serializeCertificateRecord)
}

export async function createCertificateRecord(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreateCertificateBody }
) {
  const [row] = await tx
    .insert(certRecords)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      domain: input.body.domain,
      expiresAt: new Date(input.body.expiresAt),
      alertLeadDays: input.body.alertLeadDays ?? CERTIFICATE_DEFAULT_ALERT_LEAD_DAYS,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Certificate record insert returned no row')
  return row
}

export async function findCertificateRecordInProject(
  tx: Tx,
  params: { certificateId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(certRecords)
    .where(
      and(eq(certRecords.id, params.certificateId), eq(certRecords.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export async function updateCertificateRecord(
  tx: Tx,
  input: {
    certificateId: string
    projectId: string
    body: UpdateCertificateBody
    rawBody: Record<string, unknown>
  }
) {
  const updates = buildMonitoringUpdates(
    input.rawBody,
    { key: 'domain', value: input.body.domain },
    { key: 'expiresAt', value: input.body.expiresAt },
    input.body.alertLeadDays
  )

  return applyMonitoringUpdate(
    updates,
    () =>
      findCertificateRecordInProject(tx, {
        certificateId: input.certificateId,
        projectId: input.projectId,
      }),
    async (setValues) => {
      const [updated] = await tx
        .update(certRecords)
        .set(setValues)
        .where(
          and(eq(certRecords.id, input.certificateId), eq(certRecords.projectId, input.projectId))
        )
        .returning()
      return updated ?? null
    }
  )
}

export async function deleteCertificateRecord(
  tx: Tx,
  params: { certificateId: string; projectId: string }
) {
  const [deleted] = await tx
    .delete(certRecords)
    .where(
      and(eq(certRecords.id, params.certificateId), eq(certRecords.projectId, params.projectId))
    )
    .returning()
  return deleted ?? null
}

// --- Domains (domain_records) ---

export async function listDomainRecords(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(domainRecords)
    .where(eq(domainRecords.projectId, projectId))
    .orderBy(domainRecords.createdAt)
  return rows.map(serializeDomainRecord)
}

export async function createDomainRecord(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreateDomainRecordBody }
) {
  const [row] = await tx
    .insert(domainRecords)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      domainName: input.body.domainName,
      renewalDate: new Date(input.body.renewalDate),
      alertLeadDays: input.body.alertLeadDays ?? DOMAIN_DEFAULT_ALERT_LEAD_DAYS,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Domain record insert returned no row')
  return row
}

export async function findDomainRecordInProject(
  tx: Tx,
  params: { domainId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(domainRecords)
    .where(
      and(eq(domainRecords.id, params.domainId), eq(domainRecords.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export async function updateDomainRecord(
  tx: Tx,
  input: {
    domainId: string
    projectId: string
    body: UpdateDomainRecordBody
    rawBody: Record<string, unknown>
  }
) {
  const updates = buildMonitoringUpdates(
    input.rawBody,
    { key: 'domainName', value: input.body.domainName },
    { key: 'renewalDate', value: input.body.renewalDate },
    input.body.alertLeadDays
  )

  return applyMonitoringUpdate(
    updates,
    () => findDomainRecordInProject(tx, { domainId: input.domainId, projectId: input.projectId }),
    async (setValues) => {
      const [updated] = await tx
        .update(domainRecords)
        .set(setValues)
        .where(
          and(eq(domainRecords.id, input.domainId), eq(domainRecords.projectId, input.projectId))
        )
        .returning()
      return updated ?? null
    }
  )
}

export async function deleteDomainRecord(tx: Tx, params: { domainId: string; projectId: string }) {
  const [deleted] = await tx
    .delete(domainRecords)
    .where(
      and(eq(domainRecords.id, params.domainId), eq(domainRecords.projectId, params.projectId))
    )
    .returning()
  return deleted ?? null
}

// --- Service endpoints (service_endpoints) — Story 6.2, ADR-6.2-01 ---

export class ServiceEndpointLimitReachedError extends Error {
  readonly code = 'service_endpoint_limit_reached'

  constructor(limit: number) {
    super(`This project has reached its maximum of ${limit} monitored endpoints`)
    this.name = 'ServiceEndpointLimitReachedError'
  }
}

/** Identifying + audit-tail fields shared by every monitoring-record serializer. downEpisode-
 * StartedAt is deliberately excluded (adversarial-review finding 23) — internal bookkeeping. */
export function serializeServiceEndpoint(row: typeof serviceEndpoints.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    name: row.name,
    // ADR-6.2-11: never echo the raw URL back if it carries userinfo/secret-shaped params.
    url: redactUrlForDisplay(row.url),
    checkFrequencyMinutes: row.checkFrequencyMinutes,
    downThresholdFailures: row.downThresholdFailures,
    status: row.status as 'healthy' | 'degraded' | 'down',
    consecutiveFailures: row.consecutiveFailures,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function countServiceEndpointsForProject(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.projectId, projectId))
  return row?.total ?? 0
}

export async function listServiceEndpoints(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.projectId, projectId))
    .orderBy(serviceEndpoints.createdAt)
  return rows.map(serializeServiceEndpoint)
}

/**
 * AC 1/ADR-6.2-09: checks the per-project registration cap BEFORE any SSRF validation or DB
 * write, then AC 1/2: synchronously validates the URL is not private/loopback/reserved.
 */
export async function createServiceEndpoint(
  tx: Tx,
  input: { orgId: string; projectId: string; userId: string; body: CreateServiceEndpointBody }
) {
  const existingCount = await countServiceEndpointsForProject(tx, input.projectId)
  if (existingCount >= env.MAX_SERVICE_ENDPOINTS_PER_PROJECT) {
    throw new ServiceEndpointLimitReachedError(env.MAX_SERVICE_ENDPOINTS_PER_PROJECT)
  }

  await assertUrlIsMonitorable(input.body.url)

  const [row] = await tx
    .insert(serviceEndpoints)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      name: input.body.name,
      url: input.body.url,
      checkFrequencyMinutes: input.body.checkFrequencyMinutes ?? 5,
      downThresholdFailures: input.body.downThresholdFailures ?? 2,
      createdBy: input.userId,
    })
    .returning()
  if (!row) throw new Error('Service endpoint insert returned no row')
  return row
}

export async function findServiceEndpointInProject(
  tx: Tx,
  params: { serviceEndpointId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(serviceEndpoints)
    .where(
      and(
        eq(serviceEndpoints.id, params.serviceEndpointId),
        eq(serviceEndpoints.projectId, params.projectId)
      )
    )
    .limit(1)
  return row ?? null
}

export async function updateServiceEndpoint(
  tx: Tx,
  input: {
    serviceEndpointId: string
    projectId: string
    body: UpdateServiceEndpointBody
    rawBody: Record<string, unknown>
  }
) {
  const updates: Record<string, unknown> = {}
  if ('name' in input.rawBody) updates.name = input.body.name
  if ('url' in input.rawBody && input.body.url !== undefined) {
    await assertUrlIsMonitorable(input.body.url) // AC 3: re-validated per AC 2
    updates.url = input.body.url
  }
  if ('checkFrequencyMinutes' in input.rawBody) {
    updates.checkFrequencyMinutes = input.body.checkFrequencyMinutes
  }
  if ('downThresholdFailures' in input.rawBody) {
    updates.downThresholdFailures = input.body.downThresholdFailures
  }

  if (Object.keys(updates).length === 0) {
    return findServiceEndpointInProject(tx, {
      serviceEndpointId: input.serviceEndpointId,
      projectId: input.projectId,
    })
  }

  const [updated] = await tx
    .update(serviceEndpoints)
    .set(updates)
    .where(
      and(
        eq(serviceEndpoints.id, input.serviceEndpointId),
        eq(serviceEndpoints.projectId, input.projectId)
      )
    )
    .returning()
  return updated ?? null
}

/**
 * AC 3: deleting a service-endpoint cascades its health-check history (FK ON DELETE CASCADE),
 * suppresses any still-pending notification-queue rows for it, and marks any active/snoozed
 * monitoring_alerts rows for it as a terminal `resolved_by_deletion` status so a dangling
 * snoozed alert never references a deleted endpoint. The alert-status update MUST run BEFORE
 * the endpoint delete: monitoring_alerts.serviceEndpointId is ON DELETE SET NULL (a correction
 * to this story's original ON DELETE CASCADE draft — see monitoring-alerts.ts), so deleting the
 * endpoint first would already have nulled out the very column this UPDATE filters on.
 */
export async function deleteServiceEndpoint(
  tx: Tx,
  params: { serviceEndpointId: string; projectId: string; orgId: string }
) {
  const endpoint = await findServiceEndpointInProject(tx, params)
  if (!endpoint) return null

  await tx
    .update(monitoringAlerts)
    .set({ status: 'resolved_by_deletion' })
    .where(
      and(
        eq(monitoringAlerts.serviceEndpointId, endpoint.id),
        sql`${monitoringAlerts.status} IN ('active','snoozed')`
      )
    )

  await tx
    .update(notificationQueue)
    .set({ status: 'suppressed' })
    .where(
      and(
        eq(notificationQueue.orgId, params.orgId),
        eq(notificationQueue.status, 'pending'),
        sql`${notificationQueue.payload}->>'serviceEndpointId' = ${endpoint.id}`
      )
    )

  const [deleted] = await tx
    .delete(serviceEndpoints)
    .where(
      and(
        eq(serviceEndpoints.id, params.serviceEndpointId),
        eq(serviceEndpoints.projectId, params.projectId)
      )
    )
    .returning()
  return deleted ?? null
}

// --- Health history (endpoint_health_checks) — AC 7 ---

export function serializeHealthCheck(row: typeof endpointHealthChecks.$inferSelect) {
  return {
    isHealthy: row.isHealthy,
    statusCode: row.statusCode,
    latencyMs: row.latencyMs,
    failureReason: row.failureReason as
      'timeout' | 'http_error' | 'network_error' | 'ssrf_blocked' | null,
    checkedAt: row.checkedAt.toISOString(),
  }
}

export async function listHealthHistory(
  tx: Tx,
  params: { serviceEndpointId: string; query: HealthHistoryQuery }
) {
  const conditions = [eq(endpointHealthChecks.serviceEndpointId, params.serviceEndpointId)]
  if (params.query.from)
    conditions.push(gte(endpointHealthChecks.checkedAt, new Date(params.query.from)))
  if (params.query.to)
    conditions.push(lte(endpointHealthChecks.checkedAt, new Date(params.query.to)))
  const where = and(...conditions)

  const [totalRow] = await tx.select({ total: count() }).from(endpointHealthChecks).where(where)
  const total = totalRow?.total ?? 0

  const rows = await tx
    .select()
    .from(endpointHealthChecks)
    .where(where)
    .orderBy(desc(endpointHealthChecks.checkedAt))
    .limit(params.query.limit)
    .offset((params.query.page - 1) * params.query.limit)

  return {
    items: rows.map(serializeHealthCheck),
    total,
    page: params.query.page,
    limit: params.query.limit,
    hasNext: params.query.page * params.query.limit < total,
  }
}

/**
 * AC 4-6, ADR-6.2-03/05: applies one health-check result to a service_endpoints row inside the
 * caller's transaction — inserts the endpoint_health_checks row, computes the pure status
 * transition (monitoring-alert-shared.ts), and updates the service_endpoints row accordingly.
 * downEpisodeStartedAt is set on the transition INTO down, cleared on recovery, and left
 * unchanged on every other check (needed so a still-down episode keeps referencing the same
 * episodeKey — ADR-6.2-05).
 */
export async function applyHealthCheckResult(
  tx: Tx,
  input: {
    serviceEndpoint: typeof serviceEndpoints.$inferSelect
    isHealthy: boolean
    statusCode: number | null
    latencyMs: number
    failureReason: 'timeout' | 'http_error' | 'network_error' | 'ssrf_blocked' | null
    checkedAt?: Date
  }
): Promise<{
  alertFired: MonitoringAlertType | null
  episodeKey: string | null
  updatedRow: typeof serviceEndpoints.$inferSelect
}> {
  const checkedAt = input.checkedAt ?? new Date()

  await tx.insert(endpointHealthChecks).values({
    serviceEndpointId: input.serviceEndpoint.id,
    orgId: input.serviceEndpoint.orgId,
    isHealthy: input.isHealthy,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    failureReason: input.failureReason,
    checkedAt,
  })

  const transition = computeStatusTransition({
    currentStatus: input.serviceEndpoint.status as 'healthy' | 'degraded' | 'down',
    consecutiveFailures: input.serviceEndpoint.consecutiveFailures,
    downThresholdFailures: input.serviceEndpoint.downThresholdFailures,
    isHealthy: input.isHealthy,
  })

  let downEpisodeStartedAt: Date | null = input.serviceEndpoint.downEpisodeStartedAt
  let episodeKey: string | null =
    downEpisodeStartedAt && input.serviceEndpoint.status !== 'healthy'
      ? episodeKeyFor(input.serviceEndpoint.id, downEpisodeStartedAt)
      : null

  if (transition.alertFired === 'service.down') {
    downEpisodeStartedAt = checkedAt
    episodeKey = episodeKeyFor(input.serviceEndpoint.id, downEpisodeStartedAt)
  } else if (transition.alertFired === 'service.recovery') {
    episodeKey = downEpisodeStartedAt
      ? episodeKeyFor(input.serviceEndpoint.id, downEpisodeStartedAt)
      : episodeKeyFor(input.serviceEndpoint.id, checkedAt)
    downEpisodeStartedAt = null
  }

  const [updatedRow] = await tx
    .update(serviceEndpoints)
    .set({
      status: transition.nextStatus,
      consecutiveFailures: transition.nextConsecutiveFailures,
      lastCheckedAt: checkedAt,
      downEpisodeStartedAt,
    })
    .where(eq(serviceEndpoints.id, input.serviceEndpoint.id))
    .returning()
  if (!updatedRow) throw new Error('Service endpoint update returned no row')

  return { alertFired: transition.alertFired, episodeKey, updatedRow }
}

// writeSystemAuditRow (AC 14) moved to ../../lib/system-audit-row.ts — shared by every
// background job that writes a system-initiated audit row (check-failed-auth-threshold.ts,
// check-anomalous-access.ts, this module's health-check worker), avoiding the near-identical
// HMAC/insert boilerplate being copy-pasted into each one (jscpd zero-duplication gate).
export { writeSystemAuditRow } from '../../lib/system-audit-row.js'

/**
 * ADR-6.2-05 (corrected, adversarial-review finding 5): atomically checks for an existing
 * same-episode active/snoozed monitoring_alerts row and, if none blocks it, inserts a new one —
 * wrapped by the caller in `pg_advisory_xact_lock(hashtext(serviceEndpointId))` so concurrent
 * processing of the same endpoint can never produce two rows for one episode.
 */
export async function createMonitoringAlertIfNotDeduped(
  tx: Tx,
  input: {
    orgId: string
    projectId: string
    serviceEndpointId: string
    alertType: MonitoringAlertType
    severity: 'info' | 'warning' | 'critical'
    episodeKey: string
    payload: Record<string, unknown>
  }
): Promise<typeof monitoringAlerts.$inferSelect | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.serviceEndpointId}::text))`)

  if (input.alertType === 'service.down') {
    const now = new Date()
    const [existing] = await tx
      .select()
      .from(monitoringAlerts)
      .where(
        and(
          eq(monitoringAlerts.serviceEndpointId, input.serviceEndpointId),
          eq(monitoringAlerts.episodeKey, input.episodeKey),
          sql`${monitoringAlerts.status} IN ('active','snoozed')`
        )
      )
      .limit(1)
    if (existing) {
      const stillSnoozed =
        existing.status === 'snoozed' &&
        existing.snoozedUntil !== null &&
        existing.snoozedUntil.getTime() > now.getTime()
      if (stillSnoozed || existing.status === 'active') return null
    }
  }

  const [row] = await tx
    .insert(monitoringAlerts)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      serviceEndpointId: input.serviceEndpointId,
      alertType: input.alertType,
      severity: input.severity,
      episodeKey: input.episodeKey,
      payload: input.payload,
    })
    .returning()
  return row ?? null
}

// --- Monitoring alerts (monitoring_alerts) — AC 9, 10, 17 ---

export function serializeMonitoringAlert(row: typeof monitoringAlerts.$inferSelect) {
  return {
    id: row.id,
    alertType: row.alertType as 'service.down' | 'service.recovery',
    severity: row.severity as 'info' | 'warning' | 'critical',
    status: row.status as 'active' | 'snoozed' | 'dismissed' | 'resolved_by_deletion',
    episodeKey: row.episodeKey,
    serviceEndpointId: row.serviceEndpointId,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    dismissedBy: row.dismissedBy,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function findMonitoringAlertInProject(
  tx: Tx,
  params: { alertId: string; projectId: string }
) {
  const [row] = await tx
    .select()
    .from(monitoringAlerts)
    .where(
      and(eq(monitoringAlerts.id, params.alertId), eq(monitoringAlerts.projectId, params.projectId))
    )
    .limit(1)
  return row ?? null
}

export class AlertAlreadyDismissedError extends Error {
  readonly code = 'alert_already_dismissed'

  constructor() {
    super('This alert has already been dismissed and cannot be snoozed')
    this.name = 'AlertAlreadyDismissedError'
  }
}

/** AC 9: sets status='snoozed'/snoozedUntil; re-snoozing an already-snoozed alert extends/
 * replaces snoozedUntil (idempotent-style update, not an error — adversarial-review finding 14).
 * Snoozing an already-dismissed alert is a meaningful state conflict (409). */
export async function snoozeMonitoringAlert(
  tx: Tx,
  params: { alertId: string; projectId: string; durationMinutes: number }
) {
  const existing = await findMonitoringAlertInProject(tx, params)
  if (!existing) return null
  if (existing.status === 'dismissed') throw new AlertAlreadyDismissedError()

  const snoozedUntil = new Date(Date.now() + params.durationMinutes * 60_000)
  const [updated] = await tx
    .update(monitoringAlerts)
    .set({ status: 'snoozed', snoozedUntil })
    .where(eq(monitoringAlerts.id, params.alertId))
    .returning()
  return updated ?? null
}

/** AC 10: permanently dismisses an alert — idempotent (re-dismissing an already-dismissed alert
 * succeeds harmlessly); dismiss always wins over an active snooze. */
export async function dismissMonitoringAlert(
  tx: Tx,
  params: { alertId: string; projectId: string; dismissedBy: string }
) {
  const existing = await findMonitoringAlertInProject(tx, params)
  if (!existing) return null

  const [updated] = await tx
    .update(monitoringAlerts)
    .set({ status: 'dismissed', dismissedBy: params.dismissedBy, dismissedAt: new Date() })
    .where(eq(monitoringAlerts.id, params.alertId))
    .returning()
  return updated ?? null
}

export async function listMonitoringAlerts(
  tx: Tx,
  params: { projectId: string; query: AlertListQuery }
) {
  const conditions = [eq(monitoringAlerts.projectId, params.projectId)]
  if (params.query.status) conditions.push(eq(monitoringAlerts.status, params.query.status))
  if (params.query.serviceEndpointId) {
    conditions.push(eq(monitoringAlerts.serviceEndpointId, params.query.serviceEndpointId))
  }
  const where = and(...conditions)

  const [totalRow] = await tx.select({ total: count() }).from(monitoringAlerts).where(where)
  const total = totalRow?.total ?? 0

  const rows = await tx
    .select()
    .from(monitoringAlerts)
    .where(where)
    .orderBy(desc(monitoringAlerts.createdAt))
    .limit(params.query.limit)
    .offset((params.query.page - 1) * params.query.limit)

  return {
    items: rows.map(serializeMonitoringAlert),
    total,
    page: params.query.page,
    limit: params.query.limit,
    hasNext: params.query.page * params.query.limit < total,
  }
}
