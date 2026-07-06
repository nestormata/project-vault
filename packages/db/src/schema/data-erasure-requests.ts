import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

/**
 * Story 8.4: governed GDPR/CCPA right-to-erasure workflow. Org-scoped (D1) — unlike the
 * identity-scoped tables in check-rls-coverage.ts's EXCLUDED_TABLES (mfa_recovery_codes,
 * account_recovery_tokens, etc.), this table gets a normal RLS policy (AC-19).
 *
 * No cascade delete on `userId` — `users` rows are never hard-deleted by erasure (Dev Notes),
 * so this FK stays stable for the lifetime of the erasure record.
 */
export const dataErasureRequests = pgTable(
  'data_erasure_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    // D6: keyed HMAC-SHA256(ERASURE_EMAIL_HASH_SECRET, normalizeEmail(email)) captured at
    // request-creation time, before execution overwrites users.email — the only way to check
    // "was this email ever erased" after the fact (re-invite block, AC-17/AC-17B).
    originalEmailHash: text('original_email_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    orgUserIdx: index('idx_data_erasure_requests_org_user').on(t.orgId, t.userId),
    statusCreatedIdx: index('idx_data_erasure_requests_status_created').on(t.status, t.createdAt),
    // D9: closes the request-creation race — only one pending/in_progress request per user at
    // a time. A concurrent second insert raises a unique violation the handler converts into
    // AC-4's existing "return the existing request" 409 response.
    onePendingPerUser: uniqueIndex('idx_data_erasure_requests_one_pending_per_user')
      .on(t.userId)
      .where(sql`${t.status} IN ('pending','in_progress')`),
    emailHashIdx: index('idx_data_erasure_requests_email_hash').on(t.originalEmailHash),
    statusCheck: check(
      'data_erasure_requests_status_check',
      sql`${t.status} IN ('pending','in_progress','completed')`
    ),
  })
)

export type DataErasureRequest = typeof dataErasureRequests.$inferSelect
export type NewDataErasureRequest = typeof dataErasureRequests.$inferInsert
