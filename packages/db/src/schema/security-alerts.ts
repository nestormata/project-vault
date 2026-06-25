import { pgTable, uuid, text, timestamp, jsonb, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { userIdentityTokens } from './user-identity-tokens.js'

export const securityAlerts = pgTable(
  'security_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped(),
    alertType: text('alert_type').notNull(),
    severity: text('severity').notNull(),
    // SECURITY: payload values are NEVER rendered as raw HTML — text interpolation only.
    // UI must never use {@html payload.field} or innerHTML with payload content (XSS risk).
    // Future: add CHECK constraint validating payload shape once alert types are finalized.
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('PENDING_DELIVERY'),
    dismissedBy: uuid('dismissed_by').references(() => userIdentityTokens.id),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissalReason: text('dismissal_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    severityCheck: check(
      'security_alerts_severity_check',
      sql`${t.severity} IN ('info','warning','critical')`
    ),
    statusCheck: check(
      'security_alerts_status_check',
      sql`${t.status} IN ('PENDING_DELIVERY','delivered','dismissed')`
    ),
  })
)
