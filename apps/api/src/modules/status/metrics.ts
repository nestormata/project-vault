import { Counter } from 'prom-client'

// Story 1.19 AC-6: GET /status probe traffic is high-volume and must never become a human audit
// event — instead outcomes are counted here (mirrors
// apps/api/src/modules/credential-shares/metrics.ts's Counter pattern) so operators still get
// passive dashboard visibility without flooding the platform audit log.
export const STATUS_PROBE_OUTCOME_TOTAL_METRIC_NAME = 'status_probe_outcome_total'
export const statusProbeOutcomeTotal = new Counter({
  name: STATUS_PROBE_OUTCOME_TOTAL_METRIC_NAME,
  help: 'Total number of GET /status probe requests by outcome',
  labelNames: ['outcome'],
})

export type StatusProbeOutcome =
  'success' | 'degraded' | 'unavailable' | 'unauthorized' | 'rate_limited'

export function recordStatusProbeOutcome(outcome: StatusProbeOutcome): void {
  statusProbeOutcomeTotal.labels(outcome).inc()
}
