import { pgTable, uuid, text, timestamp, integer, jsonb, check, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationQueue = pgTable(
  'notification_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    templateId: text('template_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCheck: check(
      'notification_queue_channel_check',
      sql`${t.channel} IN ('email','slack','inbox')`
    ),
    statusCheck: check(
      'notification_queue_status_check',
      sql`${t.status} IN ('pending','delivered','failed','suppressed')`
    ),
    pendingIdx: index('idx_notification_queue_pending')
      .on(t.orgId, t.status)
      .where(sql`${t.status} = 'pending'`),
    createdAtIdx: index('idx_notification_queue_created_at').on(t.createdAt),
  })
)
