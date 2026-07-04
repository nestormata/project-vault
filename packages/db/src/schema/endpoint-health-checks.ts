import { pgTable, uuid, boolean, integer, text, timestamp, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { serviceEndpoints } from './service-endpoints.js'

// IMMUTABLE: append-only — matches architecture.md's secret_versions/audit_log_entries
// convention for check-history rows. No updated_at column, no set_updated_at trigger.
// architecture.md's anti-pattern list explicitly forbids storing the response body — only
// status code, latency, and result boolean are stored (AC 4).
export const endpointHealthChecks = pgTable(
  'endpoint_health_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceEndpointId: uuid('service_endpoint_id')
      .notNull()
      .references(() => serviceEndpoints.id, { onDelete: 'cascade' }),
    ...orgScoped({ onDelete: 'cascade' }),
    isHealthy: boolean('is_healthy').notNull(),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms').notNull(),
    // ADR-6.2-12: a diagnostic column, not a service_endpoints.status value. NULL iff healthy.
    failureReason: text('failure_reason'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Health-history pagination (AC 7): newest first per endpoint.
    serviceEndpointCheckedAtIdx: index('idx_endpoint_health_checks_endpoint_checked').on(
      t.serviceEndpointId,
      t.checkedAt
    ),
    orgIdx: index('idx_endpoint_health_checks_org').on(t.orgId),
    failureReasonCheck: check(
      'endpoint_health_checks_failure_reason_check',
      sql`(${t.isHealthy} = true AND ${t.failureReason} IS NULL) OR (${t.isHealthy} = false AND ${t.failureReason} IN ('timeout','http_error','network_error','ssrf_blocked'))`
    ),
  })
)
