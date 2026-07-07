import { pgTable, uuid, text, integer, bigint, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Story 9.1 D3 — platform-level (non-org-scoped, RLS-exempt) source of truth for backup history,
 * health monitoring, and the `GET /admin/backups` listing. Follows the `vault_state`/
 * `api_instances` precedent (added to `EXCLUDED_TABLES` in check-rls-coverage.ts in this same
 * migration), not the `orgScoped()` helper — backup/restore operates at the whole-instance level
 * (D2), so this table has no `org_id` column at all.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    filename: text('filename').notNull().unique(),
    status: text('status').notNull().default('running'), // running | succeeded | failed
    triggeredBy: text('triggered_by').notNull(), // 'schedule' | 'manual'
    triggeredByUserId: uuid('triggered_by_user_id'), // NULL for schedule-triggered runs
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    keyVersion: integer('key_version'),
    checksumSha256: text('checksum_sha256'),
    verified: text('verified').notNull().default('unverified'), // unverified | valid | invalid
    errorMessage: text('error_message'),
  },
  (t) => [
    check('backup_runs_status_check', sql`${t.status} IN ('running','succeeded','failed')`),
    check('backup_runs_triggered_by_check', sql`${t.triggeredBy} IN ('schedule','manual')`),
    check('backup_runs_verified_check', sql`${t.verified} IN ('unverified','valid','invalid')`),
  ]
)
export type BackupRun = typeof backupRuns.$inferSelect
export type NewBackupRun = typeof backupRuns.$inferInsert
