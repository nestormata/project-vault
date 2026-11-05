import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * Story 43.30: a browser-approved CLI sign-in is a user session, not an organization session.
 * No org is chosen at approval time, so this table has no org_id and no RLS (same class as
 * cli_device_grants). Organization access is a separate, short-lived credential.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jti: text('jti').notNull(),
    sessionVersion: integer('session_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_user_sessions_jti').on(t.jti),
    index('idx_user_sessions_user_id').on(t.userId),
    index('idx_user_sessions_expires_at').on(t.expiresAt),
  ]
)

export const userRefreshTokens = pgTable(
  'user_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userSessionId: uuid('user_session_id')
      .notNull()
      .references(() => userSessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_user_refresh_tokens_token_hash').on(t.tokenHash),
    index('idx_user_refresh_tokens_session_id').on(t.userSessionId),
  ]
)

/**
 * Links a user session to organization credentials minted from it, so revoking the user
 * session also revokes those credentials. No RLS: the row is identity-scoped, and the
 * organization session it points at keeps its own org RLS.
 */
export const cliOrgCredentials = pgTable(
  'cli_org_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userSessionId: uuid('user_session_id')
      .notNull()
      .references(() => userSessions.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_cli_org_credentials_user_session_id').on(t.userSessionId)]
)
