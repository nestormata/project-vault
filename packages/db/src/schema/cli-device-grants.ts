import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Story 43.30: a browser-approved CLI sign-in grant. No org is known when the CLI creates the
 * row, and the poller is unauthenticated, so the table has no RLS (same class as handoff_nonces).
 * Only HMAC hashes of the codes are stored. user_id / org_id / approver_session_id are filled
 * when a signed-in browser approves, and they are plain uuids with no foreign key: the grant
 * expires in minutes and must not block a user or session delete.
 */
export const cliDeviceGrants = pgTable(
  'cli_device_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCodeHash: text('device_code_hash').notNull(),
    userCodeHash: text('user_code_hash').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    intervalSeconds: integer('interval_seconds').notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    clientName: text('client_name'),
    userId: uuid('user_id'),
    orgId: uuid('org_id'),
    approverSessionId: uuid('approver_session_id'),
    sessionId: uuid('session_id'),
    stepUpFailures: integer('step_up_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    deniedAt: timestamp('denied_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_cli_device_grants_expires_at').on(t.expiresAt),
    uniqueIndex('uq_cli_device_grants_device_code_hash').on(t.deviceCodeHash),
    uniqueIndex('uq_cli_device_grants_user_code_hash').on(t.userCodeHash),
    check(
      'cli_device_grants_status_check',
      sql`${t.status} in ('pending', 'approved', 'denied', 'consumed', 'revoked')`
    ),
  ]
)

export type CliDeviceGrant = typeof cliDeviceGrants.$inferSelect
export type NewCliDeviceGrant = typeof cliDeviceGrants.$inferInsert
