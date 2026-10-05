import type { FastifyRequest } from 'fastify'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { SecureRouteContext } from '../../lib/secure-route.js'
import { rotationResolutionsTotal } from './metrics.js'

/** Every rotation audit write shares orgId/actorUserId (from secureCtx.auth), resourceType
 *  ('rotation'), and request — only eventType/resourceId/payload vary per call site.
 *
 *  Takes `tx`/`auth` rather than the whole `secureCtx` (and callers pass `secureCtx.tx` /
 *  `secureCtx.auth` explicitly) so route-audit.test.ts's same-transaction-delegation check —
 *  which greps each route's own source for a literal `secureCtx.tx` following the delegated
 *  call — can still verify the audit write shares the route's transaction. */
export function writeRotationAuditEntry(
  tx: SecureRouteContext['tx'],
  auth: SecureRouteContext['auth'],
  req: FastifyRequest,
  input: { eventType: string; resourceId?: string; payload: Record<string, unknown> }
): Promise<void> {
  return writeHumanAuditEntryOrFailClosed(tx, {
    orgId: auth.orgId,
    actorUserId: auth.userId,
    resourceType: 'rotation',
    request: req,
    ...input,
  })
}

/** AC-11/AC-12: resume/abandon's shared success-path audit write — fail-closed, with the
 *  identical audit-failure metric/log/rethrow shape, differing only in eventType/metric outcome
 *  label/event constant/log message between the callers.
 *
 *  Takes `tx`/`auth` (see writeRotationAuditEntry) rather than `secureCtx` so
 *  route-audit.test.ts's literal `secureCtx.tx` check still passes at the call site. */
export async function writeResolutionAuditOrThrow(
  tx: SecureRouteContext['tx'],
  auth: SecureRouteContext['auth'],
  req: FastifyRequest,
  params: Record<string, unknown>,
  config: {
    eventType: string
    resourceId: string
    payload: Record<string, unknown>
    auditFailedMetricOutcome: string
    auditFailedEvent: string
    auditFailedMessage: string
  }
): Promise<void> {
  try {
    await writeRotationAuditEntry(tx, auth, req, {
      eventType: config.eventType,
      resourceId: config.resourceId,
      payload: config.payload,
    })
  } catch (error) {
    rotationResolutionsTotal.inc({ outcome: config.auditFailedMetricOutcome })
    req.log.error({ eventType: config.auditFailedEvent, ...params }, config.auditFailedMessage)
    throw error
  }
}

/** The ROTATION_ABANDONED audit write, shared by the abandon route and (Story 43-15 AC-8) the
 *  deactivate/remove routes' `rotationHandling: "abandon"` path — the latter adds its
 *  `extraPayload` (`reason` plus the deactivated/removed initiator's id). */
export function writeRotationAbandonedAuditOrThrow(
  tx: SecureRouteContext['tx'],
  auth: SecureRouteContext['auth'],
  req: FastifyRequest,
  params: { credentialId: string } & Record<string, unknown>,
  rotation: { id: string; newVersionId: string; previousVersionId: string },
  extraPayload: Record<string, unknown> = {}
): Promise<void> {
  return writeResolutionAuditOrThrow(tx, auth, req, params, {
    eventType: AuditEvent.ROTATION_ABANDONED,
    resourceId: rotation.id,
    payload: {
      credentialId: params.credentialId,
      abandonedVersionId: rotation.newVersionId,
      restoredCurrentVersionId: rotation.previousVersionId,
      ...extraPayload,
    },
    auditFailedMetricOutcome: 'abandon_audit_failed',
    auditFailedEvent: OperationalEvent.ROTATION_ABANDON_AUDIT_FAILED,
    auditFailedMessage: 'Rotation abandon audit write failed — transaction will roll back',
  })
}

/** Story 43-17 KD-6: one ROTATION_OWNERSHIP_TRANSFERRED row per hand-over, fail-closed inside the
 *  deactivate/remove transaction (an audit failure rolls the whole request back). */
export function writeRotationOwnershipTransferredAuditOrThrow(
  tx: SecureRouteContext['tx'],
  auth: SecureRouteContext['auth'],
  req: FastifyRequest,
  params: { rotationId: string } & Record<string, unknown>,
  payload: {
    credentialId: string
    fromUserId: string
    toUserId: string
    reason: 'owner_deactivated' | 'owner_removed'
    previousStatus: string
  }
): Promise<void> {
  return writeResolutionAuditOrThrow(tx, auth, req, params, {
    eventType: AuditEvent.ROTATION_OWNERSHIP_TRANSFERRED,
    resourceId: params.rotationId,
    payload,
    auditFailedMetricOutcome: 'ownership_transfer_audit_failed',
    auditFailedEvent: OperationalEvent.ROTATION_OWNERSHIP_TRANSFER_AUDIT_FAILED,
    auditFailedMessage:
      'Rotation ownership transfer audit write failed — transaction will roll back',
  })
}
