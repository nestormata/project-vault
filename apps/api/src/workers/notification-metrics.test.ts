import { describe, expect, it } from 'vitest'
import { register } from 'prom-client'
import {
  PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME,
  pgbossDlqEntriesTotal,
} from './notification-metrics.js'

describe('pgbossDlqEntriesTotal', () => {
  it('registers pgboss_dlq_entries_total labeled by job_type and increments it', async () => {
    pgbossDlqEntriesTotal.reset()
    pgbossDlqEntriesTotal.inc({ job_type: 'notification' })
    pgbossDlqEntriesTotal.inc({ job_type: 'notification' })

    const metric = await register.getSingleMetricAsString(PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME)
    expect(metric).toContain('job_type="notification"} 2')
  })

  it('re-importing the module after a module reset does not throw "metric already registered"', async () => {
    // Story 28.6 AC4 — some test files vi.resetModules() and re-import; the idempotent
    // getOrCreateCounter() registration pattern (from quota-gate.ts) must survive that.
    const existing = register.getSingleMetric(PGBOSS_DLQ_ENTRIES_TOTAL_METRIC_NAME)
    expect(existing).toBeDefined()

    const mod = await import('./notification-metrics.js')
    expect(mod.pgbossDlqEntriesTotal).toBe(existing)
  })
})
