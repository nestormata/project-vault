import { pgTable, uuid, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

// Story 6.2 (ADR-6.2-01): a new, standalone table — deliberately NOT linked to
// payment_records (no FK). architecture.md's canonical schema names this table
// service_endpoints ("HTTP uptime monitoring") as a distinct entity from payment_records
// ("Payment/subscription records"). Route: POST/GET/PATCH/DELETE
// /api/v1/projects/:projectId/service-endpoints (not /services, which is payment_records' path).
export const serviceEndpoints = pgTable(
  'service_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    checkFrequencyMinutes: integer('check_frequency_minutes').notNull().default(5),
    downThresholdFailures: integer('down_threshold_failures').notNull().default(2),
    // ADR-6.2-03: healthy (consecutiveFailures = 0), degraded (1 <= consecutiveFailures <
    // downThresholdFailures), down (consecutiveFailures >= downThresholdFailures).
    status: text('status').notNull().default('healthy'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    // Internal bookkeeping only for ADR-6.2-05's episodeKey — deliberately excluded from every
    // response schema (adversarial-review finding 23); not part of the public API contract.
    downEpisodeStartedAt: timestamp('down_episode_started_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('idx_service_endpoints_org').on(t.orgId),
    // AC 8's scheduler due-query perf note: (checkFrequencyMinutes, lastCheckedAt) index.
    dueQueryIdx: index('idx_service_endpoints_due_query').on(
      t.checkFrequencyMinutes,
      t.lastCheckedAt
    ),
    nameLenCheck: check(
      'service_endpoints_name_len_check',
      sql`char_length(${t.name}) BETWEEN 1 AND 256`
    ),
    urlLenCheck: check(
      'service_endpoints_url_len_check',
      sql`char_length(${t.url}) BETWEEN 1 AND 2048`
    ),
    checkFrequencyCheck: check(
      'service_endpoints_check_frequency_check',
      sql`${t.checkFrequencyMinutes} IN (1,5,15,30)`
    ),
    downThresholdCheck: check(
      'service_endpoints_down_threshold_check',
      sql`${t.downThresholdFailures} BETWEEN 1 AND 10`
    ),
    statusCheck: check(
      'service_endpoints_status_check',
      sql`${t.status} IN ('healthy','degraded','down')`
    ),
  })
)
