import { and, eq, gt, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { withOrg, type Tx } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type {
  ExtensionManifest,
  NotificationOriginatorChannel,
  NotificationOriginatorEnqueueForOrgParams,
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

/** Story 58.1 Task 3/AC6 — a per-extension in-flight cap for the out-of-request
 * `enqueueNotificationForOrg` method only, mirroring `monitoring-host.ts`'s
 * `MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION` precedent exactly. Distinct accounting map and
 * budget from `monitoring-host.ts`'s own, `org-authorization.ts`'s own, and
 * `capability-gate.ts`'s own — never shared. This is ALSO independent from the DB-backed
 * rolling-window COUNT budget below (`NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW`,
 * Design Decision 2/AC5) — the in-flight cap bounds CONCURRENT calls, the rolling-window cap
 * bounds SUSTAINED volume over time; a caller can be rejected by either independently. */
export const NOTIFICATION_ORIGINATOR_HOST_MAX_IN_FLIGHT_PER_EXTENSION = 20

const notificationOriginatorHostInFlightCounts = new Map<string, number>()

function outOfRequestAccountingKeyFor(extensionName: string): string {
  return `notification-originator-host:${extensionName}`
}

function tryAcquireOutOfRequestSlot(key: string, max: number): boolean {
  const current = notificationOriginatorHostInFlightCounts.get(key) ?? 0
  if (current >= max) return false
  notificationOriginatorHostInFlightCounts.set(key, current + 1)
  return true
}

function releaseOutOfRequestSlot(key: string): void {
  const current = notificationOriginatorHostInFlightCounts.get(key) ?? 0
  if (current <= 1) notificationOriginatorHostInFlightCounts.delete(key)
  else notificationOriginatorHostInFlightCounts.set(key, current - 1)
}

/** Test-only introspection — never called from production code. */
export function __getNotificationOriginatorHostInFlightCountForTests(
  extensionName: string
): number {
  return (
    notificationOriginatorHostInFlightCounts.get(outOfRequestAccountingKeyFor(extensionName)) ?? 0
  )
}

/** Test-only reset — never called from production code. */
export function __resetNotificationOriginatorHostInFlightForTests(): void {
  notificationOriginatorHostInFlightCounts.clear()
}

type AuditLogger = Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>

// Shared audit-outcome literals — constants avoid sonarjs/no-duplicate-string tripping on these
// values repeated across both enqueueNotification's and enqueueNotificationForOrg's identical
// outcome-classification shape.
const OUTCOME_OK = 'ok' as const
const OUTCOME_INVALID_PARAMS_DENIED = 'invalid-params-denied' as const
const OUTCOME_INVALID_RECIPIENT_DENIED = 'invalid-recipient-denied' as const
const OUTCOME_RATE_LIMITED = 'rate-limited' as const
const OUTCOME_ERROR = 'error' as const

type EnqueueOutcome =
  typeof OUTCOME_INVALID_RECIPIENT_DENIED | typeof OUTCOME_RATE_LIMITED | typeof OUTCOME_ERROR

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
 *
 * Story 58.1 Design Decision 2 — `outOfRequest` selects which of the two INDEPENDENT budgets this
 * call counts against: `false` (default, the in-request `enqueueNotification()` path) uses
 * `idx_notification_queue_origin_extension_rate_limit` (Task 2, Story 36.1); `true` (the
 * out-of-request `enqueueNotificationForOrg()` path) uses the sibling
 * `idx_notification_queue_ooref_extension_rate_limit` (Task 2, Story 58.1). Both share the same
 * numeric cap as a starting point (Design Decision 2) but are counted via two disjoint `WHERE`
 * clauses over the same table — a burst on one path structurally cannot exhaust the other's
 * budget.
 */
async function assertUnderRateLimit(
  tx: Tx,
  extensionName: string,
  orgId: string,
  outOfRequest = false
): Promise<void> {
  const windowStart = new Date(Date.now() - NOTIFICATION_ORIGINATOR_RATE_LIMIT_WINDOW_MS)
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationQueue)
    .where(
      and(
        eq(notificationQueue.originExtensionName, extensionName),
        eq(notificationQueue.orgId, orgId),
        eq(notificationQueue.enqueuedOutOfRequest, outOfRequest),
        gt(notificationQueue.createdAt, windowStart)
      )
    )
  const count = Number(row?.count ?? 0)
  if (count >= NOTIFICATION_ORIGINATOR_RATE_LIMIT_MAX_PER_WINDOW) {
    throw new NotificationOriginatorRateLimitedError()
  }
}

/** Story 58.1 Task 3/AC6 — the `enqueueNotificationForOrg`-only counterpart to
 * `monitoring-host.ts`'s `callOutOfRequestMethod`: wraps the out-of-request enqueue path with (a)
 * the per-extension in-flight budget above and (b) a `recordNotificationOriginatorAudit`-shaped
 * audit entry on every outcome (success, denial, or error) — the SAME field set
 * (`extensionName`/`organizationId`/`channel`/`outcome`) `enqueueNotification()` already uses,
 * never `monitoring-host.ts`'s own `method`-keyed shape, so both `NotificationOriginatorHost`
 * methods' audit trails stay uniform. */
async function callOutOfRequestEnqueue(
  organizationId: string,
  channel: string,
  hostContext: { extensionName: string; logger: AuditLogger; maxInFlight: number },
  fn: () => Promise<NotificationOriginatorEnqueueResult>
): Promise<NotificationOriginatorEnqueueResult> {
  const { extensionName, logger, maxInFlight } = hostContext
  const accountingKey = outOfRequestAccountingKeyFor(extensionName)

  if (!tryAcquireOutOfRequestSlot(accountingKey, maxInFlight)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.NOTIFICATION_ORIGINATOR_HOST_OUT_OF_REQUEST_RATE_LIMITED,
      'enqueueNotificationForOrg() call denied without invoking resolution — extension at its in-flight cap',
      { extensionName, organizationId }
    )
    recordNotificationOriginatorAudit(logger, {
      extensionName,
      organizationId,
      channel,
      outcome: OUTCOME_RATE_LIMITED,
    })
    throw new NotificationOriginatorRateLimitedError()
  }

  try {
    const result = await fn()
    recordNotificationOriginatorAudit(logger, {
      extensionName,
      organizationId,
      channel,
      outcome: OUTCOME_OK,
    })
    return result
  } catch (error) {
    let outcome: EnqueueOutcome
    if (error instanceof NotificationOriginatorInvalidRecipientError) {
      outcome = OUTCOME_INVALID_RECIPIENT_DENIED
    } else if (error instanceof NotificationOriginatorRateLimitedError) {
      outcome = OUTCOME_RATE_LIMITED
    } else {
      outcome = OUTCOME_ERROR
    }
    if (outcome === OUTCOME_RATE_LIMITED) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.NOTIFICATION_ORIGINATOR_HOST_OUT_OF_REQUEST_RATE_LIMITED,
        'enqueueNotificationForOrg() call denied — extension at its out-of-request rolling-window enqueue cap',
        { extensionName, organizationId }
      )
    }
    recordNotificationOriginatorAudit(logger, {
      extensionName,
      organizationId,
      channel,
      outcome,
    })
    throw error
  } finally {
    releaseOutOfRequestSlot(accountingKey)
  }
}

export function buildNotificationOriginatorHost(
  manifest: ExtensionManifest,
  logger: AuditLogger = {},
  /** Test-only override seam (e.g. a lowered `maxInFlight` to exercise the out-of-request
   * in-flight rate-limit path deterministically) — never used in production wiring. Mirrors
   * `monitoring-host.ts`'s `buildMonitoringHost` overrides parameter. */
  overrides: { maxInFlight?: number } = {}
): NotificationOriginatorHost {
  const outOfRequestMaxInFlight =
    overrides.maxInFlight ?? NOTIFICATION_ORIGINATOR_HOST_MAX_IN_FLIGHT_PER_EXTENSION

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
          outcome: OUTCOME_INVALID_PARAMS_DENIED,
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
          outcome: OUTCOME_OK,
        })
        return result
      } catch (error) {
        let outcome: EnqueueOutcome
        if (error instanceof NotificationOriginatorInvalidRecipientError) {
          outcome = OUTCOME_INVALID_RECIPIENT_DENIED
        } else if (error instanceof NotificationOriginatorRateLimitedError) {
          outcome = OUTCOME_RATE_LIMITED
        } else {
          outcome = OUTCOME_ERROR
        }
        if (outcome === OUTCOME_RATE_LIMITED) {
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

    async enqueueNotificationForOrg(
      params: NotificationOriginatorEnqueueForOrgParams
    ): Promise<NotificationOriginatorEnqueueResult> {
      // Story 58.1 AC1 — out-of-request-capable: the org is named explicitly via
      // `params.organizationId`, never resolved via `requireAmbientOrgId()`/
      // `getRequestContext()`. This method never throws
      // `NotificationOriginatorNoAmbientContextError`.
      try {
        validateParamsShape(params)
      } catch (error) {
        recordNotificationOriginatorAudit(logger, {
          extensionName: manifest.name,
          organizationId: params?.organizationId ?? 'unknown',
          channel: String(params?.channel),
          outcome: OUTCOME_INVALID_PARAMS_DENIED,
        })
        throw error
      }

      return callOutOfRequestEnqueue(
        params.organizationId,
        params.channel,
        { extensionName: manifest.name, logger, maxInFlight: outOfRequestMaxInFlight },
        () =>
          withOrg(params.organizationId, async (tx) => {
            if (params.recipientUserId !== undefined) {
              // AC2/AC3 — reuses `assertRecipientIsOrgMember` verbatim, scoped to the EXPLICIT
              // `params.organizationId` rather than any ambient org.
              await assertRecipientIsOrgMember(params.recipientUserId, params.organizationId)
            }

            // AC5/Design Decision 2 — the out-of-request path's OWN, independent rolling-window
            // budget: `outOfRequest: true` selects the `enqueued_out_of_request = true` partial
            // index/WHERE clause, never the in-request path's own.
            await assertUnderRateLimit(tx, manifest.name, params.organizationId, true)

            const [row] = await tx
              .insert(notificationQueue)
              .values({
                orgId: params.organizationId,
                recipientUserId: params.recipientUserId ?? null,
                recipientEmail: params.recipientEmail ?? null,
                channel: params.channel,
                templateId: `ext.${manifest.name}`,
                payload: { subject: params.subject, body: params.body },
                status: 'pending',
                originExtensionName: manifest.name,
                enqueuedOutOfRequest: true,
              })
              .returning({ id: notificationQueue.id })

            if (!row?.id) throw new Error('notificationOriginator: insert returned no row')
            return { notificationQueueId: row.id }
          })
      )
    },
  }
}
