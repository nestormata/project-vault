import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
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
    // Story 1.25 (HIGH finding, chain-link audit HMACs): the previous row's `hmac` (single global
    // chain — this table has no org_id), NULL only for the chain's true genesis row (the lowest
    // chain_seq overall).
    previousEntryHmac: text('previous_entry_hmac'),
    // Story 1.25: true insertion-order sequence. NOT createdAt — the maintenance-mode drain path
    // (PlatformAuditFields.createdAt) can insert a row with an explicit, earlier createdAt than
    // its actual insertion time, so createdAt order can diverge from insertion order for this
    // table specifically. chain_seq (GENERATED ALWAYS AS IDENTITY) is the one column guaranteed
    // to reflect true insertion order.
    chainSeq: bigint('chain_seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
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
    // Story 1.25 AC-1: chain_seq must be unique; also the ordering index for verify.ts's global
    // chain walk (ORDER BY chain_seq).
    chainSeqUniqueIdx: uniqueIndex('idx_platform_audit_events_chain_seq').on(t.chainSeq),
  })
)

export type PlatformAuditEvent = typeof platformAuditEvents.$inferSelect
export type NewPlatformAuditEvent = typeof platformAuditEvents.$inferInsert
