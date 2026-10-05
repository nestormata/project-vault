import { getOrCreateCounter } from '../lib/prom-client-registry.js'

// Story 28.6 AC4 — the architecture's existing pg-boss DLQ-monitoring rule ("pg-boss DLQ entries
// for security-sensitive job types must trigger an operational alert — pino error-level log +
// prom-client counter pgboss_dlq_entries_total{job_type}") was, per this story's own review,
// unimplemented in this codebase for ANY job family (verified by grep — zero matches for
// this counter name or any DLQ counter). This module implements it for real, for the first
// time, scoped to job_type: 'notification' only; rotation:*/audit:* remain unwired (a separate,
// pre-existing architecture-compliance gap this story surfaces but does not fix).
export const PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME = 'pgboss_dlq_entries_total'

export const pgbossDlqEntriesTotal = getOrCreateCounter<'job_type'>({
  name: PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME,
  help: 'Total number of pg-boss dead-letter entries for security-sensitive job types, labeled by job_type',
  labelNames: ['job_type'],
})

// Story 70.1 Decisions 2026-09-30 (DW-252) — rows whose send started but whose outcome was never
// recorded (crash mid-send, or a failed status commit after a resolved send). They are moved to
// `failed` instead of re-sent (at-most-once); each one also counts in pgbossDlqEntriesTotal above
// so the existing DLQ alerting covers it. Label: channel only (never a recipient).
export const NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN_TOTAL_METRIC_NAME =
  'notification_delivery_outcome_unknown_total'

export const notificationDeliveryOutcomeUnknownTotal = getOrCreateCounter<'channel'>({
  name: NOTIFICATION_DELIVERY_OUTCOME_UNKNOWN_TOTAL_METRIC_NAME,
  help: 'Total notification_queue rows failed because their send started but its outcome was never recorded (not re-sent), labeled by channel',
  labelNames: ['channel'],
})

// Story 70.3 AC4 — rows a DeliveryProvider ended with DeliveryProviderPermanentError (moved to
// `failed`, not retried). Incremented once per row this call actually transitioned. Label:
// channel only (never a recipient, subject or provider message).
export const NOTIFICATION_DELIVERY_PERMANENT_FAILURE_TOTAL_METRIC_NAME =
  'notification_delivery_permanent_failure_total'

export const notificationDeliveryPermanentFailureTotal = getOrCreateCounter<'channel'>({
  name: NOTIFICATION_DELIVERY_PERMANENT_FAILURE_TOTAL_METRIC_NAME,
  help: 'Total notification_queue rows failed without retry because the delivery provider reported a permanent failure, labeled by channel',
  labelNames: ['channel'],
})
