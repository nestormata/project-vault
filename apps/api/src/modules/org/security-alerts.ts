import { and, count, desc, eq, ne, type SQL } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import { z, type ZodType } from 'zod/v4'
import {
  anomalousAccessPayloadSchema,
  failedAuthThresholdPayloadSchema,
  machineKeyDormantPayloadSchema,
  userDormantPayloadSchema,
  type SecurityAlertsQuery,
} from './schema.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import type { FastifyRequest } from 'fastify'

function deliveryStatusFor(
  status: string
): 'pending_notification_channel' | 'delivered' | 'dismissed' {
  if (status === 'PENDING_DELIVERY') return 'pending_notification_channel'
  if (status === 'delivered') return 'delivered'
  return 'dismissed'
}

// ADR-6.2-07: `listSecurityAlertsWithTx` used to hardcode `failedAuthThresholdPayloadSchema` for
// EVERY row regardless of `alertType`, silently dropping (and only stderr-logging) any row whose
// payload didn't match that one schema. Story 6.2 starts writing `security.anomalous_access` rows
// with a DIFFERENT payload shape — without this fix, every anomalous-access alert would be
// silently invisible in this list endpoint. Select the schema by alertType instead, falling back
// to a permissive passthrough for any future/unrecognized alert type rather than dropping it.
const PAYLOAD_SCHEMA_BY_ALERT_TYPE: Record<string, ZodType> = {
  'security.failed_auth_threshold': failedAuthThresholdPayloadSchema,
  'security.anomalous_access': anomalousAccessPayloadSchema,
  'machine_key.dormant': machineKeyDormantPayloadSchema,
  // Story 8.3 D6 — without this registration, `GET /org/security-alerts` would silently drop
  // every `user.dormant` row (this file's own ADR-6.2-07 comment about exactly this failure mode).
  'user.dormant': userDormantPayloadSchema,
}
const PASSTHROUGH_PAYLOAD_SCHEMA = z.record(z.string(), z.unknown())

function payloadSchemaFor(alertType: string): ZodType {
  return PAYLOAD_SCHEMA_BY_ALERT_TYPE[alertType] ?? PASSTHROUGH_PAYLOAD_SCHEMA
}

async function listSecurityAlertsWithTx(tx: Tx, query: SecurityAlertsQuery) {
  const filters: SQL[] = []
  if (query.status !== 'all') filters.push(eq(securityAlerts.status, query.status))
  if (query.severity) filters.push(eq(securityAlerts.severity, query.severity))
  const where = filters.length ? and(...filters) : undefined

  const [totalRow] = await tx.select({ total: count() }).from(securityAlerts).where(where)
  const total = totalRow?.total ?? 0

  const rows = await tx
    .select()
    .from(securityAlerts)
    .where(where)
    .orderBy(desc(securityAlerts.createdAt))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)

  const items = rows.flatMap((row) => {
    const payload = payloadSchemaFor(row.alertType).safeParse(row.payload)
    if (!payload.success) {
      process.stderr.write(
        `[org.security_alerts.invalid_payload] alertId=${row.id} ${payload.error.message}\n`
      )
      return []
    }
    return [
      {
        id: row.id,
        alertType: row.alertType,
        severity: row.severity as 'info' | 'warning' | 'critical',
        status: row.status as 'PENDING_DELIVERY' | 'delivered' | 'dismissed',
        payload: payload.data as Record<string, unknown>,
        deliveryStatus: deliveryStatusFor(row.status),
        createdAt: row.createdAt.toISOString(),
      },
    ]
  })

  return {
    items,
    total,
    page: query.page,
    limit: query.limit,
    hasNext: query.page * query.limit < total,
  }
}

export async function listSecurityAlerts(orgId: string, query: SecurityAlertsQuery, tx?: Tx) {
  if (tx) return listSecurityAlertsWithTx(tx, query)
  return withOrg(orgId, (innerTx) => listSecurityAlertsWithTx(innerTx, query))
}

async function findSecurityAlertInOrg(tx: Tx, securityAlertId: string) {
  const [row] = await tx
    .select()
    .from(securityAlerts)
    .where(eq(securityAlerts.id, securityAlertId))
    .limit(1)
  return row ?? null
}

/**
 * AC 18 (ADR-6.2-04's correction): sets the pre-existing dismissedBy/dismissedAt/dismissalReason
 * columns (present since Story 3.4, unused until now) and records AuditEvent.
 * SECURITY_ALERT_DISMISSED fail-closed, same transaction. Idempotent on an already-dismissed row.
 */
export async function dismissSecurityAlert(
  tx: Tx,
  params: {
    securityAlertId: string
    orgId: string
    actorUserId: string
    dismissalReason?: string
    request: FastifyRequest
  }
) {
  const existing = await findSecurityAlertInOrg(tx, params.securityAlertId)
  if (!existing) return null

  // security_alerts.dismissedBy (Story 3.4) is an FK to user_identity_tokens.id, NOT users.id —
  // unlike this story's own monitoring_alerts.dismissedBy, which points at users.id directly.
  // Resolving the actor's user id to their identity token id here (same helper the audit-write
  // path already uses) avoids a foreign-key violation on dismiss.
  const dismissedByTokenId = await firstActorTokenIdForUser(tx, params.actorUserId)

  const [updated] = await tx
    .update(securityAlerts)
    .set({
      status: 'dismissed',
      dismissedBy: dismissedByTokenId,
      dismissedAt: new Date(),
      dismissalReason: params.dismissalReason ?? null,
    })
    .where(eq(securityAlerts.id, params.securityAlertId))
    .returning()
  if (!updated) return null

  await writeHumanAuditEntryOrFailClosed(tx, {
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    eventType: 'security_alert.dismissed',
    resourceId: updated.id,
    resourceType: 'security_alert',
    payload: { alertType: updated.alertType },
    request: params.request,
  })

  return updated
}

export type DismissSecurityAlertResult =
  { status: 'dismissed'; id: string } | { status: 'not_found' } | { status: 'already_dismissed' }

/**
 * Story 7.2 D9/AC-22 — generic dismiss endpoint's write path: this is the first-ever write
 * against `security_alerts.dismissedBy/dismissedAt/dismissalReason`, columns shipped in Epic 1
 * but never consumed until this story. Works identically for any future `alertType`.
 *
 * Named distinctly from `dismissSecurityAlert` above (Story 6.2's org-admin dismiss route,
 * keyed by securityAlertId+orgId+actorUserId) since both dismiss the same table via
 * independent routes/call conventions that coexist rather than one superseding the other.
 */
export async function dismissSecurityAlertByToken(
  tx: Tx,
  params: { alertId: string; actorTokenId: string | null; reason: string }
): Promise<DismissSecurityAlertResult> {
  const [claimed] = await tx
    .update(securityAlerts)
    .set({
      status: 'dismissed',
      dismissedBy: params.actorTokenId,
      dismissedAt: new Date(),
      dismissalReason: params.reason,
      updatedAt: new Date(),
    })
    .where(and(eq(securityAlerts.id, params.alertId), ne(securityAlerts.status, 'dismissed')))
    .returning({ id: securityAlerts.id })

  if (claimed) return { status: 'dismissed', id: claimed.id }

  const [existing] = await tx
    .select({ id: securityAlerts.id, status: securityAlerts.status })
    .from(securityAlerts)
    .where(eq(securityAlerts.id, params.alertId))
    .limit(1)
  if (!existing) return { status: 'not_found' }
  return { status: 'already_dismissed' }
}
