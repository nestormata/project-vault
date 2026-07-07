import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Story 9.2 D3: a new platform-level (non-org-scoped, RLS-exempt) singleton table — mirrors
 * `vault_state`'s `id smallint PRIMARY KEY DEFAULT 1` + `CHECK (id = 1)` shape. A single row is
 * upserted on first `PUT /admin/settings`; the table starts empty (AC-24) — `GET` synthesizes
 * defaults from env vars when no row exists yet (D3's precedence rule, `resolveEffectiveSettings()`
 * in `modules/platform-admin/service.ts`).
 */
export const systemSettings = pgTable(
  'system_settings',
  {
    id: smallint('id')
      .primaryKey()
      .default(sql`1`),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpSecure: boolean('smtp_secure'),
    smtpUser: text('smtp_user'),
    // EncryptedValue shape ({ version, iv, ciphertext, tag }) or NULL — see D4.
    smtpPassEncrypted: jsonb('smtp_pass_encrypted'),
    smtpFrom: text('smtp_from'),
    backupScheduleOverride: text('backup_schedule_override'),
    backupRetentionCountOverride: integer('backup_retention_count_override'),
    defaultSlackWebhookUrl: text('default_slack_webhook_url'),
    maxOrgs: integer('max_orgs').notNull().default(10),
    maxUsersPerOrg: integer('max_users_per_org').notNull().default(50),
    sessionIdleTimeoutMinutesOverride: integer('session_idle_timeout_minutes_override'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (t) => [check('system_settings_single_row', sql`${t.id} = 1`)]
)

export type SystemSettings = typeof systemSettings.$inferSelect
export type NewSystemSettings = typeof systemSettings.$inferInsert
