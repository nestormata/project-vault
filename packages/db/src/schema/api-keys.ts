import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { machineUsers } from './machine-users.js'

// Story 7.1 — machine user API keys (FR32/FR33/FR36/FR68). See story D1/D2/D3: hashed with
// HMAC-SHA256 (not BLAKE2b), `pk_` + base64url format (not `pvk_` + base62), stored in this
// architecture-canonical `api_keys` table (not `machine_user_api_keys`).
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    machineUserId: uuid('machine_user_id')
      .notNull()
      .references(() => machineUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    hmacKeyVersion: integer('hmac_key_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Default [14, 3] per epics.md AC (epics.md:1784). See expiry-alert-shared.ts / D6.
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[14, 3]'::jsonb`)
      .$type<number[]>(),
    notifiedLeadDays: jsonb('notified_lead_days')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<number[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    machineUserIdx: index('idx_api_keys_machine_user').on(t.machineUserId),
    orgIdx: index('idx_api_keys_org').on(t.orgId),
    // Non-unique by design (D2/AC-2): HMAC-SHA256 output is 256-bit, collision risk is
    // cryptographically negligible — no DB-level uniqueness backstop needed.
    keyHashIdx: index('idx_api_keys_key_hash').on(t.keyHash),
    nameLenCheck: check('api_keys_name_len_check', sql`char_length(${t.name}) BETWEEN 1 AND 128`),
  })
)

export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert
