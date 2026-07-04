import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'
import { serviceEndpoints } from './service-endpoints.js'

// Story 6.2 (ADR-6.2-04): one row per alert CONDITION INSTANCE (not per notification
// recipient) — mirrors security_alerts' shape but is project-scoped (security_alerts is
// org-scoped only) and adds serviceEndpointId/episodeKey/snoozedUntil for the service.down/
// service.recovery episode-dedup model (ADR-6.2-05). Scoped ONLY to service.down/
// service.recovery in v1 — expiry alerts (6.1) and security_alerts (3.4/6.2 anomalous-access)
// are NOT addressable through this table.
export const monitoringAlerts = pgTable(
  'monitoring_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Deliberately nullable with ON DELETE SET NULL (a correction to this story's own draft,
    // which originally specified NOT NULL + ON DELETE CASCADE — that combination silently makes
    // AC 3's "mark active/snoozed alerts resolved_by_deletion, the row survives" requirement
    // unreachable: a CASCADE delete removes the referencing row outright, regardless of what
    // status was written to it first. monitoring_alerts is a historical alert-instance record
    // (mirrors 6.1's hard-delete-needs-a-snapshot precedent) that must outlive the endpoint it
    // once monitored.
    serviceEndpointId: uuid('service_endpoint_id').references(() => serviceEndpoints.id, {
      onDelete: 'set null',
    }),
    alertType: text('alert_type').notNull(),
    severity: text('severity').notNull(),
    // ADR-6.2-05: '{serviceEndpointId}:{downTransitionAt ISO timestamp}' — identifies one
    // continuous down-to-recovery episode; used to dedup re-firing on still-down checks.
    episodeKey: text('episode_key').notNull(),
    status: text('status').notNull().default('active'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    dismissedBy: uuid('dismissed_by').references(() => users.id),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('idx_monitoring_alerts_org').on(t.orgId),
    // ADR-6.2-05's dedup lookup: find an existing active/snoozed alert for this episode.
    endpointEpisodeIdx: index('idx_monitoring_alerts_endpoint_episode').on(
      t.serviceEndpointId,
      t.episodeKey
    ),
    alertTypeCheck: check(
      'monitoring_alerts_alert_type_check',
      sql`${t.alertType} IN ('service.down','service.recovery')`
    ),
    severityCheck: check(
      'monitoring_alerts_severity_check',
      sql`${t.severity} IN ('info','warning','critical')`
    ),
    statusCheck: check(
      'monitoring_alerts_status_check',
      sql`${t.status} IN ('active','snoozed','dismissed','resolved_by_deletion')`
    ),
  })
)
