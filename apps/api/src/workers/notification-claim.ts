import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { operationalLog } from '../lib/logger.js'
import {
  claimPendingNotificationEntry,
  markNotificationSendStarted,
  releaseNotificationClaim,
  type NotificationQueueRow,
} from './notification-queue-ops.js'

/** Story 70.1 — what a claimed attempt can do besides reading its row. */
export type NotificationClaimContext = {
  /**
   * Runs the attempt's one external side effect (provider `send()`, SMTP `sendMail`, Slack
   * webhook POST). Marks the send as started first (fenced on this attempt; throws
   * NotificationClaimLostError without calling `send` if the attempt no longer owns the row).
   * If `send` throws, that is a definite failure: the claim is released and the error rethrown,
   * so the pg-boss retry sends again. Once `send` resolves, any later failure (for example the
   * terminal-status commit) does NOT release: the row is never re-sent, and the DLQ cleanup fails
   * it as outcome-unknown after the lease expires (Decisions 2026-09-30, DW-252).
   */
  externalSend<T>(send: () => Promise<T>): Promise<T>
}

type ClaimLogger = Partial<Pick<FastifyBaseLogger, 'warn'>>

/**
 * Story 70.1 AC2 — claims the row exclusively, runs `fn`, and on failure releases the claim
 * (fenced on this attempt's `attempt_count`) so the pg-boss retry can reclaim at once. A lost
 * claim returns without calling `fn`. The original error is always rethrown unchanged; a failing
 * release is logged once (recipient-free) and the row becomes reclaimable when its lease expires.
 * The success path does not release: the terminal status already makes the row unclaimable.
 */
export async function withClaimedNotification(
  notificationQueueId: string,
  orgId: string,
  fn: (entry: NotificationQueueRow, claim: NotificationClaimContext) => Promise<void>,
  logger: ClaimLogger = {}
): Promise<void> {
  const entry = await claimPendingNotificationEntry(notificationQueueId, orgId)
  if (!entry) return

  let sendResolved = false
  const claim: NotificationClaimContext = {
    async externalSend<T>(send: () => Promise<T>): Promise<T> {
      await markNotificationSendStarted(notificationQueueId, orgId, entry.attemptCount)
      const result = await send()
      sendResolved = true
      return result
    },
  }

  try {
    await fn(entry, claim)
  } catch (error) {
    if (!sendResolved) {
      await releaseOrLog(notificationQueueId, orgId, entry.attemptCount, logger)
    }
    throw error
  }
}

async function releaseOrLog(
  notificationQueueId: string,
  orgId: string,
  attemptNumber: number,
  logger: ClaimLogger
): Promise<void> {
  try {
    await releaseNotificationClaim(notificationQueueId, orgId, attemptNumber)
  } catch {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.NOTIFICATION_CLAIM_RELEASE_FAILED,
      'Notification claim release failed; the row is reclaimable once its lease expires',
      { notificationQueueId, attemptNumber }
    )
  }
}
