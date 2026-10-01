import { sql } from 'drizzle-orm'
import { OperationalEvent } from '@project-vault/shared'
import { withOrg } from '@project-vault/db'
import type { FastifyBaseLogger } from 'fastify'
import { fetchAllOrgIds } from '../middleware/rls.js'
import { operationalLog } from '../lib/logger.js'
import { mapWithConcurrency } from '../lib/map-with-concurrency.js'
import { markNotificationFailed } from './notification-queue-ops.js'
import {
  NOTIFICATION_DLQ_GRACE_SECONDS,
  NOTIFICATION_MAX_ATTEMPTS,
} from './notification-worker-common.js'
import {
  notificationDeliveryOutcomeUnknownTotal,
  pgbossDlqEntriesTotal,
} from './notification-metrics.js'

type DlqCleanupLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/**
 * Upper bound on concurrent DLQ-cleanup transactions — each holds one pooled DB connection for its
 * own `withOrg` transaction. Kept small so a cleanup tick over many orgs/rows never drains the
 * shared API pool. Rows of the SAME org also serialize on that org's audit-chain advisory lock
 * (every transition writes an audit row), so a larger value would mostly park connections.
 */
const DLQ_CLEANUP_CONCURRENCY = 2

type CandidateRow = {
  id: string
  template_id: string
  channel: string
  attempt_count: number
}

type DlqCandidate = CandidateRow & {
  kind: 'outcome_unknown' | 'exhausted'
  orgId: string
}

/**
 * Story 70.1 Decisions 2026-09-30 (DW-252) — at-most-once for an ambiguous send outcome: a
 * `pending` row whose send started (`send_started_at` set) and whose lease has expired was either
 * interrupted mid-send or had its status commit fail after a resolved send. It is never re-sent;
 * it is moved to `failed` by this cleanup, with its own recipient-free error log and counter (plus
 * the existing DLQ counter).
 */
async function selectOutcomeUnknownSends(orgId: string): Promise<DlqCandidate[]> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute<CandidateRow>(sql`
      SELECT id::text AS id, template_id, channel, attempt_count
      FROM notification_queue
      WHERE org_id = ${orgId}::uuid
        AND status = 'pending'
        AND send_started_at IS NOT NULL
        AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
    `)
  )
  return rows.map((row) => ({ ...row, kind: 'outcome_unknown', orgId }))
}

/**
 * Story 28.6 — the ordinary exhausted-attempts dead-letter. Rows with a started send are owned by
 * selectOutcomeUnknownSends above (their own reason), never by this path.
 */
async function selectExhaustedAttempts(orgId: string): Promise<DlqCandidate[]> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute<CandidateRow>(sql`
      SELECT id::text AS id, template_id, channel, attempt_count
      FROM notification_queue
      WHERE org_id = ${orgId}::uuid
        AND status = 'pending'
        AND attempt_count >= ${NOTIFICATION_MAX_ATTEMPTS}
        AND send_started_at IS NULL
        AND last_attempt_at < NOW() - (${NOTIFICATION_DLQ_GRACE_SECONDS} * INTERVAL '1 second')
    `)
  )
  return rows.map((row) => ({ ...row, kind: 'exhausted', orgId }))
}

async function selectOrgCandidates(orgId: string): Promise<DlqCandidate[]> {
  const outcomeUnknown = await selectOutcomeUnknownSends(orgId)
  const exhausted = await selectExhaustedAttempts(orgId)
  return [...outcomeUnknown, ...exhausted]
}

function recordOutcomeUnknown(candidate: DlqCandidate, logger?: DlqCleanupLogger): void {
  notificationDeliveryOutcomeUnknownTotal.inc({ channel: candidate.channel })
  pgbossDlqEntriesTotal.inc({ job_type: 'notification' })
  if (logger) {
    operationalLog(
      logger,
      'error',
      OperationalEvent.NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN,
      'Notification send outcome unknown (interrupted or unrecorded); marked failed, not re-sent',
      {
        notificationQueueId: candidate.id,
        templateId: candidate.template_id,
        channel: candidate.channel,
        attemptNumber: candidate.attempt_count,
      }
    )
  }
}

function recordExhausted(candidate: DlqCandidate, logger?: DlqCleanupLogger): void {
  // Story 28.6 AC4 — per-row operational visibility (counter + error log) on top of, not instead
  // of, the existing count-only summary below, so a permanently-undeliverable notification is
  // traceable back to its poison payload without a manual DB query.
  pgbossDlqEntriesTotal.inc({ job_type: 'notification' })
  if (logger) {
    operationalLog(
      logger,
      'error',
      OperationalEvent.NOTIFICATION_DLQ_ENTRY_FAILED,
      'Notification permanently dead-lettered after exhausting retry attempts',
      { templateId: candidate.template_id, notificationQueueId: candidate.id }
    )
  }
}

/**
 * Moves one candidate to `failed` through markNotificationFailed — the rank-guarded, audited
 * applyDeliveryStatusUpdate path (row lock re-check, exactly one audit row per transition) — and
 * records its per-row metrics/log only when THIS call actually transitioned it. Returns 1 when it
 * did, else 0, so an already-terminal row is never double-counted.
 */
async function failCandidate(candidate: DlqCandidate, logger?: DlqCleanupLogger): Promise<number> {
  if (!(await markNotificationFailed(candidate.id, candidate.orgId))) return 0
  if (candidate.kind === 'outcome_unknown') recordOutcomeUnknown(candidate, logger)
  else recordExhausted(candidate, logger)
  return 1
}

export async function runNotificationDlqCleanup(logger?: DlqCleanupLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  // Orgs are independent (separate rows, separate audit chains), so both phases run with bounded
  // concurrency rather than one org/row at a time — never an unbounded fan-out over the pool.
  const candidatesPerOrg = await mapWithConcurrency(
    orgIds,
    DLQ_CLEANUP_CONCURRENCY,
    selectOrgCandidates
  )
  const transitioned = await mapWithConcurrency(
    candidatesPerOrg.flat(),
    DLQ_CLEANUP_CONCURRENCY,
    (candidate) => failCandidate(candidate, logger)
  )
  const count = transitioned.reduce((total, n) => total + n, 0)

  if (count > 0 && logger) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.NOTIFICATION_DLQ_CLEANUP_SUMMARY,
      'Notification DLQ cleanup marked exhausted notification_queue entries failed',
      { count }
    )
  }
}
