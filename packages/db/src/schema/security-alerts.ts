import { pgTable, uuid, text, timestamp, jsonb, check, uniqueIndex } from 'drizzle-orm/pg-core'
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
    // Story 7.2 AC-21 — dedupe: at most one non-dismissed machine_key.dormant alert per key.
    dormantKeyUniqueIdx: uniqueIndex('idx_security_alerts_dormant_key')
      .on(sql`(${t.payload}->>'keyId')`)
      .where(sql`${t.alertType} = 'machine_key.dormant' AND ${t.status} != 'dismissed'`),
    // Story 8.3 D5/AC-11 — dedupe: at most one non-dismissed user.dormant alert per (org, user).
    // Fix (code review): must be scoped per-org, not globally on userId alone — D9 establishes
    // that a single user can belong to multiple orgs sharing one identity, so a global-only key
    // would let one org's alert silently suppress (via ON CONFLICT DO NOTHING) another org's
    // otherwise-independent dormant-user alert for the same shared user, permanently starving
    // that second org of the notification until the first org's alert happens to be dismissed.
    dormantUserUniqueIdx: uniqueIndex('idx_security_alerts_dormant_user')
      .on(t.orgId, sql`(${t.payload}->>'userId')`)
      .where(sql`${t.alertType} = 'user.dormant' AND ${t.status} != 'dismissed'`),
  })
)
