import { z } from 'zod/v4'
import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { projects, securityAlerts } from '@project-vault/db/schema'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import { buildPaginationMeta, paginationOffset, parsePagination } from '../../lib/pagination.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { BossService } from '../../lib/boss.js'
import {
  enqueueSecurityAlertNotification,
  sendNotificationJobs,
  type NotificationQueueJob,
} from '../../notifications/dispatcher.js'
import { env } from '../../config/env.js'
import { PROJECT_ARCHIVED_ERROR } from '../projects/archive-guards.js'
import {
  AbandonRotationBodySchema,
  AbandonRotationResponseSchema,
  BreakGlassRotationBodySchema,
  BreakGlassRotationResponseSchema,
  CompleteRotationBodySchema,
  CompleteRotationResponseSchema,
  ConfirmChecklistItemBodySchema,
  ConfirmChecklistItemResponseSchema,
  AcknowledgementRequiredResponseSchema,
  AlreadyConfirmedResponseSchema,
  ChecklistIncompleteResponseSchema,
  ConcurrentModificationResponseSchema,
  FailChecklistItemBodySchema,
  FailChecklistItemResponseSchema,
  InitiateRotationBodySchema,
  InitiateRotationResponseSchema,
  InvalidItemStatusResponseSchema,
  ListRotationsQuerySchema,
  MaxRetriesExceededResponseSchema,
  ResumeRotationBodySchema,
  ResumeRotationResponseSchema,
  RetryChecklistItemBodySchema,
  RetryChecklistItemResponseSchema,
  RotationChecklistItemParamsSchema,
  RotationConflictResponseSchema,
  RotationCredentialParamsSchema,
  RotationDetailResponseSchema,
  RotationHistoryResponseSchema,
  RotationLockContentionResponseSchema,
  RotationNotActiveResponseSchema,
  RotationNotStaleResponseSchema,
  RotationParamsSchema,
  UpcomingRotationsQuerySchema,
  UpcomingRotationsResponseSchema,
  type AbandonRotationBody,
  type BreakGlassRotationBody,
  type CompleteRotationBody,
  type ConfirmChecklistItemBody,
  type FailChecklistItemBody,
  type InitiateRotationBody,
  type ResumeRotationBody,
  type RotationParams,
} from './schema.js'
import {
  RotationConflictError,
  abandonRotation,
  breakGlassRotation,
  completeRotation,
  confirmChecklistItem,
  failChecklistItem,
  findCredentialInProject,
  getRotationDetail,
  getUpcomingRotations,
  initiateRotation,
  listRotationHistory,
  resumeRotation,
  retryChecklistItem,
  serializeBreakGlassRotation,
  serializeChecklistItem,
  serializeRotationDetail,
} from './service.js'
import {
  rotationBreakGlassTotal,
  rotationChecklistConfirmationsTotal,
  rotationChecklistFailuresTotal,
  rotationChecklistRetriesTotal,
  rotationCompletionsTotal,
  rotationInitiationsTotal,
  rotationResolutionsTotal,
} from './metrics.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const ROTATION_NOT_FOUND = { code: 'rotation_not_found', message: 'Rotation not found' } as const
// AC-17: GET .../rotations/upcoming against a cross-org/nonexistent :projectId reuses the same
// project-not-found shape every other project-scoped route already has (no new logic).
const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const CHECKLIST_ITEM_NOT_FOUND = {
  code: 'checklist_item_not_found',
  message: 'Checklist item not found',
} as const

/** Shared by initiate and break-glass: both service calls return `status:
 *  'credential_not_found'` for the same cross-org/nonexistent-credential case. A type predicate
 *  (rather than a plain boolean) so the caller's `result` narrows to the non-not-found variant
 *  after the guard, same as the inline `if (result.status === 'credential_not_found')` it replaces. */
function isCredentialFound<T extends { status: string }>(
  result: T
): result is Exclude<T, { status: 'credential_not_found' }> {
  return result.status !== 'credential_not_found'
}

/** Every audit write in this file shares orgId/actorUserId (from secureCtx.auth), resourceType
 *  ('rotation'), and request — only eventType/resourceId/payload vary per call site.
 *
 *  Takes `tx`/`auth` rather than the whole `secureCtx` (and callers pass `secureCtx.tx` /
 *  `secureCtx.auth` explicitly) so route-audit.test.ts's same-transaction-delegation check —
 *  which greps each route's own source for a literal `secureCtx.tx` following the delegated
 *  call — can still verify the audit write shares the route's transaction. */
function writeRotationAuditEntry(
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

/** Shared by resume and abandon: identical params schema and empty-body validation. */
function parseResolutionRequest<TBody>(
  req: FastifyRequest,
  reply: FastifyReply,
  bodySchema: z.ZodType<TBody>
): RotationParams | undefined {
  const params = parseParams(RotationParamsSchema, req, reply)
  if (!params) return undefined
  const parsed = parseBody<TBody>(bodySchema, req, reply)
  if (!parsed.success) return undefined
  return params
}

/** Shared by resume and abandon: both build the identical
 *  {orgId, projectId, credentialId, rotationId} service args from `params` — only the service
 *  function invoked (resumeRotation vs abandonRotation) differs. */
function callResolutionService<TResult>(
  serviceFn: (
    tx: SecureRouteContext['tx'],
    args: { orgId: string; projectId: string; credentialId: string; rotationId: string }
  ) => Promise<TResult>,
  secureCtx: SecureRouteContext,
  params: RotationParams
): Promise<TResult> {
  return serviceFn(secureCtx.tx, {
    orgId: secureCtx.auth.orgId,
    projectId: params.projectId,
    credentialId: params.credentialId,
    rotationId: params.rotationId,
  })
}

const INITIATE_ROTATION_RATE_LIMIT = {
  max: 30,
  timeWindowMs: 60_000,
  key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations',
} as const

// AC-23: 60/min for the four checklist/completion mutation endpoints — more generous than
// initiation's 30/min (routine, frequent action) but tighter than the 120/min default. The
// bucket is always prefixed with the caller's userId by enforceUserRateLimit — never global or
// org-wide despite the literal method+path key (verified against secure-route.ts/route-helpers.ts).
function checklistMutationRateLimit(key: string) {
  return { max: 60, timeWindowMs: 60_000, key } as const
}

type BossFastify = FastifyApp & { boss?: BossService }

/** Post-commit, best-effort notification dispatch — identical pattern to
 *  apps/api/src/modules/auth/routes.ts's sendPendingMfaNotifications. A missed boss.send() is
 *  safe: the notification_queue row is already durable and the notification/*-catchup cron
 *  will pick it up. */
async function sendPendingRotationNotifications(
  fastify: FastifyApp,
  request: { log: { warn: (payload: unknown, msg: string) => void } },
  jobs: NotificationQueueJob[]
): Promise<void> {
  const boss = (fastify as BossFastify).boss
  if (!boss || jobs.length === 0) return
  try {
    await sendNotificationJobs(boss, jobs)
  } catch (error) {
    request.log.warn({ err: error }, 'rotation notification dispatch failed')
  }
}

// Story 5.3 AC-7: `apps/api/src/notifications/templates/index.ts`'s generic fallback renderer
// (used by `rotation.break_glass` — no dedicated template file, same precedent as 5.2's
// "Notification Integration Pattern" decision) interpolates `JSON.stringify(payload, null, 2)`
// directly into an HTML `<pre>` block with NO escaping — verified by reading the actual
// renderer, not assumed. `reason` is admin-controlled free text (AC-4), so without this,
// Slack mrkdwn/HTML control sequences (`<!channel>`, `<script>...`) would reach an external
// channel unescaped. Applied ONLY at the point `reason` enters the outbound notification
// payload — the audit/security_alerts payloads keep the raw, unmodified string for fidelity.
function sanitizeReasonForOutboundNotification(reason: string): string {
  return reason
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Story 5.3 AC-11/AC-12/AC-17: resume/abandon share this identical set of lock/scope/state
// failure outcomes — centralizing the reply/logging dispatch here keeps each route handler
// down to just its own success-path logic (audit write + metric + response shape).
type ResolutionFailureOutcome =
  | { outcome: 'locked_conflict'; currentVersion: number | null }
  | { outcome: 'concurrent_modification'; currentVersion: number | null }
  | { outcome: 'rotation_not_found' }
  | { outcome: 'rotation_not_stale'; status: string }

function isResolutionFailure<T extends { outcome: string }>(
  result: T
): result is Extract<T, ResolutionFailureOutcome> {
  return (
    result.outcome === 'locked_conflict' ||
    result.outcome === 'concurrent_modification' ||
    result.outcome === 'rotation_not_found' ||
    result.outcome === 'rotation_not_stale'
  )
}

function replyForResolutionFailure(
  reply: FastifyReply,
  req: FastifyRequest,
  outcome: ResolutionFailureOutcome,
  logParams: Record<string, unknown>,
  events: { concurrentEvent: string; notStaleEvent: string }
): unknown {
  if (outcome.outcome === 'locked_conflict' || outcome.outcome === 'concurrent_modification') {
    req.log.info(
      { eventType: events.concurrentEvent, ...logParams },
      'Rotation resolution rejected — concurrent modification'
    )
    return reply.status(409).send(concurrentModificationResponse(outcome.currentVersion))
  }
  if (outcome.outcome === 'rotation_not_found') return reply.status(404).send(ROTATION_NOT_FOUND)
  req.log.info(
    { eventType: events.notStaleEvent, ...logParams },
    'Rotation resolution rejected — not awaiting stale-recovery resolution'
  )
  return reply.status(422).send({
    code: 'rotation_not_stale' as const,
    message: 'This rotation is not awaiting stale-recovery resolution.',
    status: outcome.status,
  })
}

/** AC-11/AC-12: resume/abandon's shared success-path audit write — fail-closed, with the
 *  identical audit-failure metric/log/rethrow shape, differing only in eventType/metric outcome
 *  label/event constant/log message between the two callers.
 *
 *  Takes `tx`/`auth` (see writeRotationAuditEntry) rather than `secureCtx` so
 *  route-audit.test.ts's literal `secureCtx.tx` check still passes at the call site. */
async function writeResolutionAuditOrThrow(
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

function rotationNotActiveResponse(status: string) {
  return {
    code: 'rotation_not_active' as const,
    message: 'This rotation is not in progress.',
    status,
  }
}

function concurrentModificationResponse(currentVersion: number | null) {
  return {
    code: 'concurrent_modification' as const,
    message: 'Another update to this rotation is in progress. Retry.',
    currentVersion: currentVersion ?? 0,
  }
}

const COMMON_LOCK_OUTCOMES = new Set([
  'locked_conflict',
  'rotation_not_found',
  'rotation_not_active',
  'item_not_found',
  'concurrent_modification',
])

type CommonLockOutcomeShape = {
  outcome:
    | 'locked_conflict'
    | 'rotation_not_found'
    | 'rotation_not_active'
    | 'item_not_found'
    | 'concurrent_modification'
  currentVersion?: number | null
  status?: string
}

/** confirm/fail/retry share this exact set of AC-8/AC-17 lock-and-scope failure outcomes —
 *  centralizing the reply/logging/metric dispatch here keeps each route handler's own
 *  cyclomatic complexity down to just its operation-specific branches. */
function isCommonLockOutcome<T extends { outcome: string }>(
  result: T
): result is Extract<T, CommonLockOutcomeShape> {
  return COMMON_LOCK_OUTCOMES.has(result.outcome)
}

function replyForCommonLockOutcome(
  reply: FastifyReply,
  req: FastifyRequest,
  outcome: {
    outcome:
      | 'locked_conflict'
      | 'rotation_not_found'
      | 'rotation_not_active'
      | 'item_not_found'
      | 'concurrent_modification'
    currentVersion?: number | null
    status?: string
  },
  logParams: Record<string, unknown>,
  events: { concurrentEvent: string; notActiveEvent: string }
): unknown {
  if (outcome.outcome === 'locked_conflict' || outcome.outcome === 'concurrent_modification') {
    req.log.info(
      { eventType: events.concurrentEvent, ...logParams },
      'rejected — concurrent modification'
    )
    return reply.status(409).send(concurrentModificationResponse(outcome.currentVersion ?? null))
  }
  if (outcome.outcome === 'rotation_not_found') return reply.status(404).send(ROTATION_NOT_FOUND)
  if (outcome.outcome === 'rotation_not_active') {
    req.log.info(
      { eventType: events.notActiveEvent, ...logParams },
      'rejected — rotation not active'
    )
    return reply.status(422).send(rotationNotActiveResponse(outcome.status ?? 'unknown'))
  }
  return reply.status(404).send(CHECKLIST_ITEM_NOT_FOUND)
}

/** confirm/fail/retry/complete all build this identical scope-and-actor params object from the
 *  parsed route params + secure context before adding their own operation-specific `body`. */
function itemActionScope(
  secureCtx: SecureRouteContext,
  params: { projectId: string; credentialId: string; rotationId: string; itemId: string }
) {
  return {
    orgId: secureCtx.auth.orgId,
    projectId: params.projectId,
    credentialId: params.credentialId,
    rotationId: params.rotationId,
    itemId: params.itemId,
    userId: secureCtx.auth.userId,
  }
}

// AC-24: rotation_checklist_confirmations_total{outcome="...|invalid_state|concurrent_modification"}
// — maps the shared lock-failure outcomes onto confirm's specific metric label vocabulary.
const CONFIRM_LOCK_OUTCOME_METRIC: Partial<
  Record<string, 'concurrent_modification' | 'invalid_state'>
> = {
  locked_conflict: 'concurrent_modification',
  concurrent_modification: 'concurrent_modification',
  rotation_not_active: 'invalid_state',
  item_not_found: 'invalid_state',
}

export async function rotationRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations',
    schema: {
      response: {
        201: InitiateRotationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: RotationConflictResponseSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      // Rotation initiation writes a new live credential value and is one of the most
      // security-sensitive write paths in the system — same MFA-enrollment posture as
      // project archive/unarchive/transfer-ownership (see AC-7's required MFA test).
      requireMfa: true,
      rateLimit: INITIATE_ROTATION_RATE_LIMIT,
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationCredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<InitiateRotationBody>(InitiateRotationBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      let result
      try {
        result = await initiateRotation(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          credentialId: params.credentialId,
          userId: secureCtx.auth.userId,
          body: parsed.data,
        })
      } catch (error) {
        if (error instanceof RotationConflictError) {
          rotationInitiationsTotal.inc({ outcome: 'conflict' })
          req.log.info(
            {
              eventType: OperationalEvent.ROTATION_INITIATE_CONFLICT,
              orgId: secureCtx.auth.orgId,
              credentialId: params.credentialId,
            },
            'Rotation initiation rejected — a rotation is already in progress'
          )
          return reply.status(409).send({
            code: 'rotation_in_progress',
            message: 'A rotation is already in progress for this credential.',
            rotationId: error.rotationId,
          })
        }
        throw error
      }

      if (result.status === 'project_archived') {
        rotationInitiationsTotal.inc({ outcome: 'project_archived' })
        req.log.info(
          {
            eventType: OperationalEvent.ROTATION_INITIATE_PROJECT_ARCHIVED,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            projectId: params.projectId,
          },
          'Rotation initiation rejected — project is archived'
        )
        return reply.status(410).send(PROJECT_ARCHIVED_ERROR)
      }

      if (!isCredentialFound(result)) {
        return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      }

      try {
        await writeRotationAuditEntry(secureCtx.tx, secureCtx.auth, req, {
          eventType: AuditEvent.ROTATION_INITIATED,
          resourceId: result.rotation.id,
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            checklistItemCount: result.checklistItems.length,
          },
        })
      } catch (error) {
        rotationInitiationsTotal.inc({ outcome: 'audit_failed' })
        req.log.error(
          {
            eventType: OperationalEvent.ROTATION_INITIATE_AUDIT_FAILED,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
          },
          'Rotation initiation audit write failed — transaction will roll back'
        )
        throw error
      }

      rotationInitiationsTotal.inc({ outcome: 'success' })
      if (result.sameValueAsPrevious) {
        req.log.warn(
          {
            eventType: OperationalEvent.ROTATION_INITIATE_SAME_VALUE_WARNING,
            credentialId: params.credentialId,
            rotationId: result.rotation.id,
          },
          'Rotation initiated with a newValue identical to the previous version'
        )
      }
      req.log.info(
        {
          eventType: OperationalEvent.ROTATION_INITIATE_SUCCESS,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          rotationId: result.rotation.id,
          itemCount: result.checklistItems.length,
        },
        'Rotation initiated'
      )

      reply.status(201)
      return {
        data: serializeRotationDetail(result.rotation, result.checklistItems, {
          sameValueAsPrevious: result.sameValueAsPrevious,
        }),
      }
    },
  })

  // Story 5.3 AC-23: rarer, higher-blast-radius than normal initiation's 30/min — a legitimate
  // incident responder needs at most a handful of break-glass calls per minute across an org.
  const BREAK_GLASS_RATE_LIMIT = {
    max: 10,
    timeWindowMs: 60_000,
    key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass',
  } as const

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/break-glass',
    schema: {
      response: {
        201: BreakGlassRotationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: RotationLockContentionResponseSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      // CR4/ADR-5.3-03: "org_admin" resolves to minimumRole: 'admin' (admin + owner) — no
      // project-role dimension is ever consulted by rotation routes.
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: BREAK_GLASS_RATE_LIMIT,
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationCredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<BreakGlassRotationBody>(BreakGlassRotationBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await breakGlassRotation(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        credentialId: params.credentialId,
        userId: secureCtx.auth.userId,
        body: parsed.data,
        overlapMinutes: env.BREAK_GLASS_OVERLAP_MINUTES,
        idempotencyWindowSeconds: env.BREAK_GLASS_IDEMPOTENCY_WINDOW_SECONDS,
      })

      if (result.status === 'lock_contention') {
        rotationBreakGlassTotal.inc({ outcome: 'conflict' })
        req.log.info(
          {
            eventType: OperationalEvent.ROTATION_BREAK_GLASS_LOCK_CONTENTION,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
          },
          'Break-glass rejected — lock contention'
        )
        return reply.status(409).send({
          code: 'rotation_lock_contention' as const,
          message: 'Another rotation operation is in progress for this credential. Retry.',
          credentialId: params.credentialId,
        })
      }
      if (!isCredentialFound(result)) {
        return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      }

      // Story 5.5 AC-4: a rapid double-submit — this is really the same logical event as the
      // first call, so it must not re-write the audit/security-alert/notification side effects
      // a second time (that would be its own kind of duplication bug).
      if (result.deduped) {
        rotationBreakGlassTotal.inc({ outcome: 'deduped' })
        req.log.info(
          {
            eventType: OperationalEvent.ROTATION_BREAK_GLASS_SUCCESS,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
            rotationId: result.rotation.id,
            deduped: true,
          },
          'Break-glass rejected as a duplicate — returning the already-created rotation'
        )
        reply.status(201)
        return { data: serializeBreakGlassRotation(result) }
      }

      try {
        await writeRotationAuditEntry(secureCtx.tx, secureCtx.auth, req, {
          eventType: AuditEvent.ROTATION_BREAK_GLASS_INITIATED,
          resourceId: result.rotation.id,
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            reason: parsed.data.reason,
            supersededRotationId: result.supersededRotationId,
          },
        })

        if (result.supersededRotationId) {
          await writeRotationAuditEntry(secureCtx.tx, secureCtx.auth, req, {
            eventType: AuditEvent.ROTATION_SUPERSEDED_BY_BREAK_GLASS,
            resourceId: result.rotation.id,
            payload: {
              supersededRotationId: result.supersededRotationId,
              supersedingRotationId: result.rotation.id,
            },
          })
          rotationBreakGlassTotal.inc({ outcome: 'superseded' })
          req.log.info(
            {
              eventType: OperationalEvent.ROTATION_BREAK_GLASS_SUPERSEDED,
              orgId: secureCtx.auth.orgId,
              credentialId: params.credentialId,
              supersededRotationId: result.supersededRotationId,
              rotationId: result.rotation.id,
            },
            'Break-glass superseded an existing active rotation'
          )
        }

        // AC-7: paired critical security_alerts row — represents FR108's "high-severity audit
        // event" (audit_log_entries has no literal severity column).
        await secureCtx.tx.insert(securityAlerts).values({
          orgId: secureCtx.auth.orgId,
          alertType: 'rotation.break_glass',
          severity: 'critical',
          status: 'delivered',
          payload: {
            rotationId: result.rotation.id,
            credentialId: params.credentialId,
            projectId: params.projectId,
            reason: parsed.data.reason,
            dependentSystems: result.dependentSystems.map((dep) => dep.systemName),
          },
        })
      } catch (error) {
        rotationBreakGlassTotal.inc({ outcome: 'audit_failed' })
        req.log.error(
          {
            eventType: OperationalEvent.ROTATION_BREAK_GLASS_AUDIT_FAILED,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
          },
          'Break-glass audit write failed — transaction will roll back'
        )
        throw error
      }

      // AC-7 sweep-checklist notification. `reason` is admin-controlled free text that will be
      // rendered into an outbound Slack/email message via the generic fallback renderer
      // (apps/api/src/notifications/templates/index.ts), which interpolates the JSON-stringified
      // payload directly into an HTML `<pre>` block with no escaping — sanitize it here, at the
      // point it enters the OUTBOUND payload only (the audit/security_alerts payload above keeps
      // the raw, unmodified text for audit fidelity).
      const jobs = await enqueueSecurityAlertNotification({
        orgId: secureCtx.auth.orgId,
        templateId: 'rotation.break_glass',
        payload: {
          rotationId: result.rotation.id,
          credentialId: params.credentialId,
          projectId: params.projectId,
          reason: sanitizeReasonForOutboundNotification(parsed.data.reason),
          dependentSystems: result.dependentSystems.map((dep) => dep.systemName),
        },
        severity: 'critical',
        tx: secureCtx.tx,
      })

      rotationBreakGlassTotal.inc({ outcome: 'success' })
      req.log.info(
        {
          eventType: OperationalEvent.ROTATION_BREAK_GLASS_SUCCESS,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          rotationId: result.rotation.id,
          supersededRotationId: result.supersededRotationId,
        },
        'Break-glass rotation completed'
      )

      await sendPendingRotationNotifications(fastify, req, jobs)

      reply.status(201)
      return { data: serializeBreakGlassRotation(result) }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId',
    schema: {
      response: {
        200: RotationDetailResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const credentialExists = await findCredentialInProject(secureCtx.tx, params)
      if (!credentialExists) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      const detail = await getRotationDetail(secureCtx.tx, params)
      if (!detail) return reply.status(404).send(ROTATION_NOT_FOUND)

      return { data: detail }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/rotations',
    schema: {
      response: {
        200: RotationHistoryResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: {
        max: 120,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/projects/:projectId/credentials/:credentialId/rotations',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationCredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsedQuery = ListRotationsQuerySchema.safeParse(req.query)
      if (!parsedQuery.success) {
        return reply.status(422).send(validationError(parsedQuery.error, 'query'))
      }
      const secureCtx = ctx as SecureRouteContext

      const credentialExists = await findCredentialInProject(secureCtx.tx, params)
      if (!credentialExists) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      const pagination = parsePagination(parsedQuery.data.page, parsedQuery.data.limit)
      const offset = paginationOffset(pagination)
      const { items, total } = await listRotationHistory(secureCtx.tx, {
        ...params,
        query: parsedQuery.data,
        limit: pagination.limit,
        offset,
      })
      const meta = buildPaginationMeta(pagination, total)
      return {
        data: {
          items,
          page: meta.page,
          limit: meta.limit,
          total: meta.total,
          hasMore: meta.hasNext,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/confirm',
    schema: {
      response: {
        200: ConfirmChecklistItemResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([AlreadyConfirmedResponseSchema, ConcurrentModificationResponseSchema]),
        422: z.union([RotationNotActiveResponseSchema, ApiErrorSchema]),
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: checklistMutationRateLimit(
        'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/confirm'
      ),
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationChecklistItemParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<ConfirmChecklistItemBody>(ConfirmChecklistItemBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await confirmChecklistItem(secureCtx.tx, {
        ...itemActionScope(secureCtx, params),
        body: parsed.data,
      })

      if (isCommonLockOutcome(result)) {
        const metricOutcome = CONFIRM_LOCK_OUTCOME_METRIC[result.outcome]
        if (metricOutcome) rotationChecklistConfirmationsTotal.inc({ outcome: metricOutcome })
        return replyForCommonLockOutcome(reply, req, result, params, {
          concurrentEvent: OperationalEvent.ROTATION_CHECKLIST_CONFIRM_CONCURRENT_MODIFICATION,
          notActiveEvent: OperationalEvent.ROTATION_CHECKLIST_CONFIRM_INVALID_STATE,
        })
      }
      if (result.outcome === 'already_confirmed') {
        rotationChecklistConfirmationsTotal.inc({ outcome: 'already_confirmed' })
        req.log.info(
          { eventType: OperationalEvent.ROTATION_CHECKLIST_CONFIRM_ALREADY_CONFIRMED, ...params },
          'Checklist confirm rejected — already confirmed'
        )
        return reply.status(409).send({
          code: 'already_confirmed',
          message: 'This checklist item is already confirmed.',
          confirmedBy: result.item.confirmedBy,
          confirmedAt: result.item.confirmedAt?.toISOString() ?? null,
        })
      }

      try {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.ROTATION_CHECKLIST_ITEM_CONFIRMED,
          resourceId: result.item.id,
          resourceType: 'rotation',
          payload: {
            rotationId: params.rotationId,
            itemId: params.itemId,
            credentialId: params.credentialId,
            systemName: result.item.systemName,
          },
          request: req,
        })
      } catch (error) {
        rotationChecklistConfirmationsTotal.inc({ outcome: 'audit_failed' })
        req.log.error(
          { eventType: OperationalEvent.ROTATION_CHECKLIST_CONFIRM_AUDIT_FAILED, ...params },
          'Checklist confirm audit write failed — transaction will roll back'
        )
        throw error
      }

      rotationChecklistConfirmationsTotal.inc({ outcome: 'success' })
      req.log.info(
        { eventType: OperationalEvent.ROTATION_CHECKLIST_CONFIRM_SUCCESS, ...params },
        'Checklist item confirmed'
      )
      return {
        data: {
          item: serializeChecklistItem(result.item),
          rotationVersion: result.rotationVersion,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/fail',
    schema: {
      response: {
        200: FailChecklistItemResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([InvalidItemStatusResponseSchema, ConcurrentModificationResponseSchema]),
        422: z.union([RotationNotActiveResponseSchema, ApiErrorSchema]),
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: checklistMutationRateLimit(
        'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/fail'
      ),
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationChecklistItemParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<FailChecklistItemBody>(FailChecklistItemBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await failChecklistItem(secureCtx.tx, {
        ...itemActionScope(secureCtx, params),
        body: parsed.data,
      })

      if (isCommonLockOutcome(result)) {
        return replyForCommonLockOutcome(reply, req, result, params, {
          concurrentEvent: OperationalEvent.ROTATION_CHECKLIST_FAIL_CONCURRENT_MODIFICATION,
          notActiveEvent: OperationalEvent.ROTATION_CHECKLIST_FAIL_INVALID_STATE,
        })
      }
      if (result.outcome === 'invalid_item_status') {
        req.log.info(
          { eventType: OperationalEvent.ROTATION_CHECKLIST_FAIL_INVALID_STATE, ...params },
          'Checklist fail rejected — invalid item status'
        )
        return reply.status(409).send({
          code: 'invalid_item_status',
          message: `Cannot fail an item with status '${result.item.status}'.`,
          currentStatus: result.item.status,
          lastActedBy: result.item.lastActedBy,
          lastActedAt: result.item.lastActedAt?.toISOString() ?? null,
        })
      }

      try {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.ROTATION_CHECKLIST_ITEM_FAILED,
          resourceId: result.item.id,
          resourceType: 'rotation',
          payload: {
            rotationId: params.rotationId,
            itemId: params.itemId,
            credentialId: params.credentialId,
            systemName: result.item.systemName,
            reason: parsed.data.reason,
          },
          request: req,
        })
      } catch (error) {
        req.log.error(
          { eventType: OperationalEvent.ROTATION_CHECKLIST_FAIL_AUDIT_FAILED, ...params },
          'Checklist fail audit write failed — transaction will roll back'
        )
        throw error
      }

      rotationChecklistFailuresTotal.inc()
      req.log.info(
        { eventType: OperationalEvent.ROTATION_CHECKLIST_FAIL_SUCCESS, ...params },
        'Checklist item failed'
      )

      await sendPendingRotationNotifications(fastify, req, result.jobs)

      return {
        data: {
          item: serializeChecklistItem(result.item),
          rotationVersion: result.rotationVersion,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/retry',
    schema: {
      response: {
        200: RetryChecklistItemResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([InvalidItemStatusResponseSchema, ConcurrentModificationResponseSchema]),
        422: z.union([
          RotationNotActiveResponseSchema,
          MaxRetriesExceededResponseSchema,
          ApiErrorSchema,
        ]),
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: checklistMutationRateLimit(
        'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/retry'
      ),
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationChecklistItemParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<Record<string, never>>(RetryChecklistItemBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await retryChecklistItem(secureCtx.tx, itemActionScope(secureCtx, params))

      if (isCommonLockOutcome(result)) {
        return replyForCommonLockOutcome(reply, req, result, params, {
          concurrentEvent: OperationalEvent.ROTATION_CHECKLIST_RETRY_CONCURRENT_MODIFICATION,
          notActiveEvent: OperationalEvent.ROTATION_CHECKLIST_RETRY_INVALID_STATE,
        })
      }
      if (result.outcome === 'invalid_item_status') {
        req.log.info(
          { eventType: OperationalEvent.ROTATION_CHECKLIST_RETRY_INVALID_STATE, ...params },
          'Checklist retry rejected — invalid item status'
        )
        return reply.status(409).send({
          code: 'invalid_item_status',
          message: `Cannot retry an item with status '${result.item.status}'.`,
          currentStatus: result.item.status,
          lastActedBy: result.item.lastActedBy,
          lastActedAt: result.item.lastActedAt?.toISOString() ?? null,
        })
      }

      if (result.outcome === 'max_retries_exceeded') {
        try {
          await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
            orgId: secureCtx.auth.orgId,
            actorUserId: secureCtx.auth.userId,
            eventType: AuditEvent.ROTATION_CHECKLIST_ITEM_MAX_RETRIES_EXCEEDED,
            resourceId: result.item.id,
            resourceType: 'rotation',
            payload: {
              rotationId: params.rotationId,
              itemId: params.itemId,
              credentialId: params.credentialId,
              systemName: result.item.systemName,
              retryCount: result.retryCount,
            },
            request: req,
          })
        } catch (error) {
          req.log.error(
            { eventType: OperationalEvent.ROTATION_CHECKLIST_RETRY_AUDIT_FAILED, ...params },
            'Checklist retry (max-exceeded) audit write failed — transaction will roll back'
          )
          throw error
        }

        rotationChecklistRetriesTotal.inc({ outcome: 'max_exceeded' })
        req.log.info(
          {
            eventType: OperationalEvent.ROTATION_CHECKLIST_RETRY_MAX_EXCEEDED,
            ...params,
            retryCount: result.retryCount,
          },
          'Checklist item exceeded max retries'
        )

        await sendPendingRotationNotifications(fastify, req, result.jobs)

        reply.status(422)
        return {
          code: 'max_retries_exceeded',
          message: `Maximum retry attempts (${result.maxRetries}) reached for this item. Escalate or confirm manually.`,
          retryCount: result.retryCount,
          maxRetries: result.maxRetries,
        }
      }

      try {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.ROTATION_CHECKLIST_ITEM_RETRIED,
          resourceId: result.item.id,
          resourceType: 'rotation',
          payload: {
            rotationId: params.rotationId,
            itemId: params.itemId,
            credentialId: params.credentialId,
            systemName: result.item.systemName,
            retryCount: result.item.retryCount,
          },
          request: req,
        })
      } catch (error) {
        req.log.error(
          { eventType: OperationalEvent.ROTATION_CHECKLIST_RETRY_AUDIT_FAILED, ...params },
          'Checklist retry audit write failed — transaction will roll back'
        )
        throw error
      }

      rotationChecklistRetriesTotal.inc({ outcome: 'success' })
      req.log.info(
        { eventType: OperationalEvent.ROTATION_CHECKLIST_RETRY_SUCCESS, ...params },
        'Checklist item retried'
      )
      return {
        data: {
          item: serializeChecklistItem(result.item),
          rotationVersion: result.rotationVersion,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId/complete',
    schema: {
      response: {
        200: CompleteRotationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ConcurrentModificationResponseSchema,
        // ApiErrorSchema deliberately listed LAST: it's a non-.strict() schema that would
        // otherwise successfully (and silently) match any of the more specific error shapes
        // above and strip their extra fields, since zod tries union members in array order and
        // returns the first successful parse.
        422: z.union([
          RotationNotActiveResponseSchema,
          ChecklistIncompleteResponseSchema,
          AcknowledgementRequiredResponseSchema,
          ApiErrorSchema,
        ]),
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: checklistMutationRateLimit(
        'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/complete'
      ),
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CompleteRotationBody>(CompleteRotationBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await completeRotation(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        credentialId: params.credentialId,
        rotationId: params.rotationId,
        userId: secureCtx.auth.userId,
        body: parsed.data,
      })

      if (result.outcome === 'locked_conflict' || result.outcome === 'concurrent_modification') {
        req.log.info(
          { eventType: OperationalEvent.ROTATION_COMPLETE_CONCURRENT_MODIFICATION, ...params },
          'Rotation complete rejected — concurrent modification'
        )
        return reply.status(409).send(concurrentModificationResponse(result.currentVersion))
      }
      if (result.outcome === 'rotation_not_found') return reply.status(404).send(ROTATION_NOT_FOUND)
      if (result.outcome === 'rotation_not_active') {
        return reply.status(422).send(rotationNotActiveResponse(result.status))
      }
      if (result.outcome === 'checklist_incomplete') {
        rotationCompletionsTotal.inc({ outcome: 'checklist_incomplete' })
        req.log.info(
          {
            eventType: OperationalEvent.ROTATION_COMPLETE_CHECKLIST_INCOMPLETE,
            ...params,
            pendingCount: result.pendingItems.length,
          },
          'Rotation complete rejected — checklist incomplete'
        )
        return reply.status(422).send({
          code: 'checklist_incomplete',
          message: `${result.pendingItems.length} of ${result.totalItemCount} checklist items are not yet confirmed.`,
          pendingItems: result.pendingItems,
        })
      }
      if (result.outcome === 'acknowledgement_required') {
        rotationCompletionsTotal.inc({ outcome: 'acknowledgement_required' })
        req.log.info(
          { eventType: OperationalEvent.ROTATION_COMPLETE_ACKNOWLEDGEMENT_REQUIRED, ...params },
          'Rotation complete rejected — acknowledgement required'
        )
        return reply.status(422).send({
          code: 'acknowledgement_required',
          message:
            'This credential has no recorded dependent systems. Confirm you have manually verified the credential is updated everywhere it is used before completing.',
          checklistItemCount: 0 as const,
        })
      }

      const confirmedCount = result.checklistItems.filter(
        (item) => item.status === 'confirmed'
      ).length
      try {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.ROTATION_COMPLETED,
          resourceId: result.rotation.id,
          resourceType: 'rotation',
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            checklistItemCount: result.checklistItems.length,
            confirmedCount,
            // Story 5.5 AC-13: the two credential-version ids this completion retired/promoted —
            // both already present on the `rotations` row (Story 5.1 schema) — so a completion
            // event's version history no longer requires a manual join against `rotations`.
            previousVersionId: result.rotation.previousVersionId,
            newVersionId: result.rotation.newVersionId,
            // Story 5.5 AC-2: visible-but-not-blocking single-actor self-attestation flag.
            singleActorAttested: result.singleActorAttested,
          },
          request: req,
        })
      } catch (error) {
        req.log.error(
          { eventType: OperationalEvent.ROTATION_COMPLETE_AUDIT_FAILED, ...params },
          'Rotation complete audit write failed — transaction will roll back'
        )
        throw error
      }

      rotationCompletionsTotal.inc({ outcome: 'success' })
      req.log.info(
        {
          eventType: OperationalEvent.ROTATION_COMPLETE_SUCCESS,
          ...params,
          credentialId: params.credentialId,
        },
        'Rotation completed'
      )

      return {
        data: serializeRotationDetail(result.rotation, result.checklistItems),
      }
    },
  })

  // Story 5.3 AC-23: resume/abandon match normal initiation's cadence (occasional admin
  // decisions, not routine bookkeeping) — 30/min, tighter than the 60/min checklist-mutation
  // bucket but more generous than break-glass's 10/min.
  function resolutionRateLimit(key: string) {
    return { max: 30, timeWindowMs: 60_000, key } as const
  }

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId/resume',
    schema: {
      response: {
        200: ResumeRotationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ConcurrentModificationResponseSchema,
        422: z.union([RotationNotStaleResponseSchema, ApiErrorSchema]),
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: resolutionRateLimit(
        'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/resume'
      ),
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseResolutionRequest<ResumeRotationBody>(
        req,
        reply,
        ResumeRotationBodySchema
      )
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await callResolutionService(resumeRotation, secureCtx, params)

      if (isResolutionFailure(result)) {
        return replyForResolutionFailure(reply, req, result, params, {
          concurrentEvent: OperationalEvent.ROTATION_RESUME_CONCURRENT_MODIFICATION,
          notStaleEvent: OperationalEvent.ROTATION_RESUME_NOT_STALE,
        })
      }

      await writeResolutionAuditOrThrow(secureCtx.tx, secureCtx.auth, req, params, {
        eventType: AuditEvent.ROTATION_RESUMED,
        resourceId: result.rotation.id,
        payload: { credentialId: params.credentialId, previousStatus: 'stale_recovery' },
        auditFailedMetricOutcome: 'resume_audit_failed',
        auditFailedEvent: OperationalEvent.ROTATION_RESUME_AUDIT_FAILED,
        auditFailedMessage: 'Rotation resume audit write failed — transaction will roll back',
      })

      rotationResolutionsTotal.inc({ outcome: 'resumed' })
      req.log.info(
        { eventType: OperationalEvent.ROTATION_RESUME_SUCCESS, ...params },
        'Rotation resumed'
      )

      return { data: serializeRotationDetail(result.rotation, result.checklistItems) }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId/abandon',
    schema: {
      response: {
        200: AbandonRotationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ConcurrentModificationResponseSchema,
        422: z.union([RotationNotStaleResponseSchema, ApiErrorSchema]),
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: resolutionRateLimit(
        'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/abandon'
      ),
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseResolutionRequest<AbandonRotationBody>(
        req,
        reply,
        AbandonRotationBodySchema
      )
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await callResolutionService(abandonRotation, secureCtx, params)

      if (isResolutionFailure(result)) {
        return replyForResolutionFailure(reply, req, result, params, {
          concurrentEvent: OperationalEvent.ROTATION_ABANDON_CONCURRENT_MODIFICATION,
          notStaleEvent: OperationalEvent.ROTATION_ABANDON_NOT_STALE,
        })
      }

      await writeResolutionAuditOrThrow(secureCtx.tx, secureCtx.auth, req, params, {
        eventType: AuditEvent.ROTATION_ABANDONED,
        resourceId: result.rotation.id,
        payload: {
          credentialId: params.credentialId,
          abandonedVersionId: result.rotation.newVersionId,
          restoredCurrentVersionId: result.rotation.previousVersionId,
        },
        auditFailedMetricOutcome: 'abandon_audit_failed',
        auditFailedEvent: OperationalEvent.ROTATION_ABANDON_AUDIT_FAILED,
        auditFailedMessage: 'Rotation abandon audit write failed — transaction will roll back',
      })

      rotationResolutionsTotal.inc({ outcome: 'abandoned' })
      req.log.info(
        { eventType: OperationalEvent.ROTATION_ABANDON_SUCCESS, ...params },
        'Rotation abandoned'
      )

      return { data: serializeRotationDetail(result.rotation, result.checklistItems) }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/rotations/upcoming',
    schema: {
      response: {
        200: UpcomingRotationsResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(z.object({ projectId: z.uuid() }), req, reply)
      if (!params) return reply
      const parsedQuery = UpcomingRotationsQuerySchema.safeParse(req.query)
      if (!parsedQuery.success) {
        return reply.status(422).send(validationError(parsedQuery.error, 'query'))
      }
      const secureCtx = ctx as SecureRouteContext

      const projectRows = await secureCtx.tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .limit(1)
      if (!projectRows[0]) return reply.status(404).send(PROJECT_NOT_FOUND)

      const horizonDaysByToken = { '7d': 7, '30d': 30, '90d': 90 } as const
      const items = await getUpcomingRotations(secureCtx.tx, {
        projectId: params.projectId,
        horizonDays: horizonDaysByToken[parsedQuery.data.horizon],
      })
      return { data: { items } }
    },
  })
}
