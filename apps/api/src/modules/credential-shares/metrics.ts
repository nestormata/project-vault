import { Counter } from 'prom-client'

// Story 17.3 AC-7/Task 2.3: follows `rotationStaleStagedAlertsTotal`'s pattern
// (apps/api/src/modules/rotation/metrics.ts) — a simple counter of shares transitioned by the
// hourly expiry-sweep worker, giving passive dashboard visibility into how much lazy-check-only
// coverage would otherwise have missed.
export const CREDENTIAL_SHARE_EXPIRY_SWEEP_TOTAL_METRIC_NAME = 'credential_share_expiry_sweep_total'
export const credentialShareExpirySweepTotal = new Counter({
  name: CREDENTIAL_SHARE_EXPIRY_SWEEP_TOTAL_METRIC_NAME,
  help: 'Total number of credential_shares rows transitioned active -> expired by the scheduled expiry-sweep worker',
})
