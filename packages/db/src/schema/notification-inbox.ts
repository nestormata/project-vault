import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationInbox = pgTable(
  'notification_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    severity: text('severity').notNull().default('warning'),
    payload: jsonb('payload').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    unreadIdx: index('notification_inbox_unread_idx')
      .on(t.orgId, t.userId, t.readAt)
      .where(sql`${t.readAt} IS NULL AND ${t.dismissedAt} IS NULL`),
    expiryIdx: index('notification_inbox_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.dismissedAt} IS NULL`),
    userInboxIdx: index('notification_inbox_user_idx').on(t.orgId, t.userId, t.createdAt),
  })
)
