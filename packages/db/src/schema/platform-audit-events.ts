import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

// IMMUTABLE: append-only, no updates permitted
//
// Story 9.4 D2: platform-level (whole-instance, not per-org) compliance-grade audit log for
// privileged platform-operator actions — a sibling to `platform_security_events`, NOT a rename
// of `audit_log_entries`. No `org_id` column: this table is not tenant-scoped (D4). `target_org_id`
// / `target_user_id` intentionally have NO FK constraint (AC-1 edge case) — an audit trail must
// never be blocked by, or cascade-deleted alongside, the entity it references.
export const platformAuditEvents = pgTable(
  'platform_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => users.id),
    actionType: text('action_type').notNull(),
    targetOrgId: uuid('target_org_id'),
    targetUserId: uuid('target_user_id'),
    payload: jsonb('payload').notNull().default({}),
    ipAddress: text('ip_address'),
    keyVersion: integer('key_version').notNull(),
    hmac: text('hmac').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NO updated_at: immutable table
  },
  (t) => ({
    operatorCreatedIdx: index('idx_platform_audit_events_operator_created').on(
      t.operatorId,
      t.createdAt.desc()
    ),
    actionTypeIdx: index('idx_platform_audit_events_action_type').on(
      t.actionType,
      t.createdAt.desc()
    ),
    targetOrgIdx: index('idx_platform_audit_events_target_org').on(
      t.targetOrgId,
      t.createdAt.desc()
    ),
  })
)

export type PlatformAuditEvent = typeof platformAuditEvents.$inferSelect
export type NewPlatformAuditEvent = typeof platformAuditEvents.$inferInsert
