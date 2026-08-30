import { getOrCreateCounter } from '../lib/prom-client-registry.js'

// Story 28.6 AC4 — architecture.md's existing pg-boss DLQ-monitoring rule ("pg-boss DLQ entries
// for security-sensitive job types must trigger an operational alert — pino error-level log +
// prom-client counter pgboss_dlq_entries_total{job_type}") was, per this story's own elicitation
// pass, unimplemented in this codebase for ANY job family (verified by grep — zero matches for
// this counter name or any DLQ counter). This module implements it for real, for the first
// time, scoped to job_type: 'notification' only; rotation:*/audit:* remain unwired (a separate,
// pre-existing architecture-compliance gap this story surfaces but does not fix).
export const PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME = 'pgboss_dlq_entries_total'

export const pgbossDlqEntriesTotal = getOrCreateCounter<'job_type'>({
  name: PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME,
  help: 'Total number of pg-boss dead-letter entries for security-sensitive job types, labeled by job_type',
  labelNames: ['job_type'],
})
