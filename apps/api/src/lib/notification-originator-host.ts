import { and, eq, gt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { withOrg, type Tx } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type {
  ExtensionManifest,
  NotificationOriginatorChannel,
  NotificationOriginatorEnqueueParams,
  NotificationOriginatorEnqueueResult,
  NotificationOriginatorHost,
} from '@project-vault/extension-api'
import {
  NotificationOriginatorInvalidParamsError,
  NotificationOriginatorInvalidRecipientError,
  NotificationOriginatorNoAmbientContextError,
  NotificationOriginatorRateLimitedError,
} from '@project-vault/extension-api'
import { resolveActiveOrgRole } from '../plugins/authenticate.js'
import { getRequestContext } from './request-context.js'
import { operationalLog } from './logger.js'

/**
 * Story 36.1 — the real `HostServices.notificationOriginator` implementation, bound to the
 * loading extension's own manifest by `apps/api/src/extensions/loader.ts`'s
 * `buildHostServices()`. See `packages/extension-api/src/hooks/notification-originator.ts` for
 * the full contract doc comment this module implements against.
 *
 * **Reliance on the existing notification catch-up mechanism.** Unlike PV's own internal call
 * sites (`notifications/dispatcher.ts`), this host does not call `boss.send('notification/deliver',
 * ...)` after inserting the row — `buildHostServices()` runs at extension-load time, well before
 * any `BossService` instance exists for this process (see `loader.ts`'s `raceWithTimeout()`).
 * This is safe: inserting a `status: 'pending'` row is already durable, and PV's existing
 * notification catch-up cron (`notification/backfill-pending-delivery`) picks up any pending row
 * whose job was never enqueued or was missed — the exact same "a missed boss.send() is safe"
 * property `notifications/dispatcher.ts`'s own `dispatchPendingJobs()` doc comment already relies
 * on for post-commit, best-effort dispatch.
 */

export const MAX_SUBJECT_LENGTH = 500
export const MAX_BODY_LENGTH = 20_000

/** Design Decision 6 — a rolling-window COUNT cap, not an in-flight/concurrency cap (see
 * `hooks/notification-originator.ts`'s doc comment on `NotificationOriginatorRateLimitedError`
 * for the full best-effort/TOCTOU rationale). 100 enqueues per (extension, org) per rolling hour
 * is generous for any legitimate single-incident fan-out while bounding a runaway loop. */
export const NOTIFICATION_ORIGINATOR_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
export const NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW = 100

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

/** Structured audit-log entry recorded on EVERY call (success, denial, or error). Fields are
 * `organizationId`/`extensionName`/`channel`/`outcome` only — never the caller-authored
 * `subject`/`body` message content itself (Task 3). */
function recordNotificationOriginatorAudit(
  logger: AuditLogger,
  fields: { extensionName: string; organizationId: string; channel: string; outcome: string }
): void {
  try {
    operationalLog(
      logger,
      'info',
      OperationalEvent.NOTIFICATION_ORIGINATOR_HOST_CALL_RECORDED,
      'HostServices.notificationOriginator.enqueueNotification() call recorded',
      fields
    )
  } catch {
    // Never let an audit-logging failure surface to the caller.
  }
}

const LEGAL_CHANNELS: readonly NotificationOriginatorChannel[] = ['email', 'inbox']

function isLegalChannel(value: unknown): value is NotificationOriginatorChannel {
  return typeof value === 'string' && (LEGAL_CHANNELS as readonly string[]).includes(value)
}

/** Extracted from `validateParamsShape` purely to keep its own cyclomatic complexity under this
 * repo's lint budget: the `channel`/`subject`/`body` shape checks. */
function validateChannelAndContentShape(params: NotificationOriginatorEnqueueParams): void {
  if (!isLegalChannel(params.channel)) {
    throw new NotificationOriginatorInvalidParamsError(
      `channel must be one of ${LEGAL_CHANNELS.join(', ')}`
    )
  }
  if (typeof params.subject !== 'string' || params.subject.length === 0) {
    throw new NotificationOriginatorInvalidParamsError('subject must be a non-empty string')
  }
  if (params.subject.length > MAX_SUBJECT_LENGTH) {
    throw new NotificationOriginatorInvalidParamsError(
      `subject exceeds the maximum length of ${MAX_SUBJECT_LENGTH}`
    )
  }
  if (typeof params.body !== 'string' || params.body.length === 0) {
    throw new NotificationOriginatorInvalidParamsError('body must be a non-empty string')
  }
  if (params.body.length > MAX_BODY_LENGTH) {
    throw new NotificationOriginatorInvalidParamsError(
      `body exceeds the maximum length of ${MAX_BODY_LENGTH}`
    )
  }
}

/** Extracted from `validateParamsShape` for the same complexity-budget reason as
 * `validateChannelAndContentShape` above: the recipient-field-combination checks. */
function validateRecipientShape(params: NotificationOriginatorEnqueueParams): void {
  const hasRecipientUserId = params.recipientUserId !== undefined
  const hasRecipientEmail = params.recipientEmail !== undefined
  if (hasRecipientUserId === hasRecipientEmail) {
    throw new NotificationOriginatorInvalidParamsError(
      'exactly one of recipientUserId or recipientEmail must be supplied'
    )
  }
  if (hasRecipientEmail && params.channel === 'inbox') {
    throw new NotificationOriginatorInvalidParamsError(
      'recipientEmail is not legal for channel "inbox" — inbox delivery requires recipientUserId'
    )
  }
}

/**
 * AC4/Design Decision 5 — validates shape BEFORE any DB call: `channel` in the legal set,
 * `subject`/`body` non-empty strings within their caps, exactly one of
 * `recipientUserId`/`recipientEmail`, and `recipientEmail` only legal for `channel: 'email'`
 * (`channel: 'inbox'` structurally requires a real user row, mirroring
 * `deliverInboxNotification`'s own hard `recipientUserId` requirement).
 */
function validateParamsShape(params: NotificationOriginatorEnqueueParams): void {
  validateChannelAndContentShape(params)
  validateRecipientShape(params)
}

/** AC2/AC3 — every in-request call's shared ambient-context gate: reads `getRequestContext()`
 * fresh at call time, fails closed with zero DB calls when unbound. */
function requireAmbientOrgId(): string {
  const context = getRequestContext()
  if (!context) throw new NotificationOriginatorNoAmbientContextError()
  return context.orgId
}

/**
 * AC4 — validates that `recipientUserId` resolves to an ACTIVE member of the ambient org, via
 * `authenticate.ts`'s existing `resolveActiveOrgRole()` (the same shared query
 * `checkOrgAuthorization()` uses) — no new membership-resolution logic is written here. Returns
 * void; throws the non-enumerating `NotificationOriginatorInvalidRecipientError` for every
 * negative case (nonexistent id, real user in a different org, or a real member whose row is not
 * `status: 'active'`) so a caller can never distinguish which.
 */
async function assertRecipientIsOrgMember(recipientUserId: string, orgId: string): Promise<void> {
  const role = await resolveActiveOrgRole(recipientUserId, orgId)
  if (!role) throw new NotificationOriginatorInvalidRecipientError()
}

/**
 * AC5/Design Decision 6 — a DB-backed rolling-window COUNT, not an in-memory counter (a process
 * restart must not reset the cap). Best-effort/check-then-act: see
 * `NotificationOriginatorRateLimitedError`'s own doc comment for the accepted TOCTOU trade-off.
 * Uses the `idx_notification_queue_origin_extension_rate_limit` partial index (Task 2).
 */
async function assertUnderRateLimit(tx: Tx, extensionName: string, orgId: string): Promise<void> {
  const windowStart = new Date(Date.now() - NOTIFICATION_ORIGINATOR_RATE_LIMIT_WINDOW_MS)
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationQueue)
    .where(
      and(
        eq(notificationQueue.originExtensionName, extensionName),
        eq(notificationQueue.orgId, orgId),
        gt(notificationQueue.createdAt, windowStart)
      )
    )
  const count = Number(row?.count ?? 0)
  if (count >= NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW) {
    throw new NotificationOriginatorRateLimitedError()
  }
}

export function buildNotificationOriginatorHost(
  manifest: ExtensionManifest,
  logger: AuditLogger = {}
): NotificationOriginatorHost {
  return {
    async enqueueNotification(
      params: NotificationOriginatorEnqueueParams
    ): Promise<NotificationOriginatorEnqueueResult> {
      // AC3 — resolved ambiently; there is structurally no field on `params` through which a
      // caller could name a different org. Zero DB calls before this resolves.
      const orgId = requireAmbientOrgId()

      try {
        validateParamsShape(params)
      } catch (error) {
        recordNotificationOriginatorAudit(logger, {
          extensionName: manifest.name,
          organizationId: orgId,
          channel: String(params.channel),
          outcome: 'invalid-params-denied',
        })
        throw error
      }

      try {
        const result = await withOrg(orgId, async (tx) => {
          if (params.recipientUserId !== undefined) {
            await assertRecipientIsOrgMember(params.recipientUserId, orgId)
          }

          await assertUnderRateLimit(tx, manifest.name, orgId)

          const [row] = await tx
            .insert(notificationQueue)
            .values({
              orgId,
              recipientUserId: params.recipientUserId ?? null,
              recipientEmail: params.recipientEmail ?? null,
              channel: params.channel,
              templateId: `ext.${manifest.name}`,
              payload: { subject: params.subject, body: params.body },
              status: 'pending',
              originExtensionName: manifest.name,
            })
            .returning({ id: notificationQueue.id })

          if (!row?.id) throw new Error('notificationOriginator: insert returned no row')
          return { notificationQueueId: row.id }
        })

        recordNotificationOriginatorAudit(logger, {
          extensionName: manifest.name,
          organizationId: orgId,
          channel: params.channel,
          outcome: 'ok',
        })
        return result
      } catch (error) {
        let outcome: 'invalid-recipient-denied' | 'rate-limited' | 'error'
        if (error instanceof NotificationOriginatorInvalidRecipientError) {
          outcome = 'invalid-recipient-denied'
        } else if (error instanceof NotificationOriginatorRateLimitedError) {
          outcome = 'rate-limited'
        } else {
          outcome = 'error'
        }
        if (outcome === 'rate-limited') {
          operationalLog(
            logger,
            'warn',
            OperationalEvent.NOTIFICATION_ORIGINATOR_HOST_RATE_LIMITED,
            'enqueueNotification() call denied — extension at its rolling-window enqueue cap',
            { extensionName: manifest.name, organizationId: orgId }
          )
        }
        recordNotificationOriginatorAudit(logger, {
          extensionName: manifest.name,
          organizationId: orgId,
          channel: params.channel,
          outcome,
        })
        throw error
      }
    },
  }
}
