import { Counter, register } from 'prom-client'

// Story 28.6 AC4 — architecture.md's existing pg-boss DLQ-monitoring rule ("pg-boss DLQ entries
// for security-sensitive job types must trigger an operational alert — pino error-level log +
// prom-client counter pgboss_dlq_entries_total{job_type}") was, per this story's own elicitation
// pass, unimplemented in this codebase for ANY job family (verified by grep — zero matches for
// this counter name or any DLQ counter). This module implements it for real, for the first
// time, scoped to job_type: 'notification' only; rotation:*/audit:* remain unwired (a separate,
// pre-existing architecture-compliance gap this story surfaces but does not fix).
export const PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME = 'pgboss_dlq_entries_total'

// Idempotent registration, following apps/api/src/modules/audit/quota-gate.ts's
// getOrCreateCounter() pattern: some test files vi.resetModules() and re-import this module,
// which would otherwise trigger prom-client's "already registered" throw on re-construction.
function getOrCreateCounter<T extends string = string>(
  config: ConstructorParameters<typeof Counter<T>>[0]
): Counter<T> {
  const existing = register.getSingleMetric(config.name)
  if (existing instanceof Counter) return existing as Counter<T>
  return new Counter(config)
}

export const pgbossDlqEntriesTotal = getOrCreateCounter<'job_type'>({
  name: PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME,
  help: 'Total number of pg-boss dead-letter entries for security-sensitive job types, labeled by job_type',
  labelNames: ['job_type'],
})
