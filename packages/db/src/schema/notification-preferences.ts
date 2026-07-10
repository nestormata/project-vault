import { pgTable, uuid, text, timestamp, check, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    channel: text('channel').notNull(),
    frequency: text('frequency').notNull().default('immediate'),
    minSeverity: text('min_severity').notNull().default('warning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCheck: check(
      'notification_preferences_channel_check',
      sql`${t.channel} IN ('email','slack','inbox','none')`
    ),
    frequencyCheck: check(
      'notification_preferences_frequency_check',
      sql`${t.frequency} IN ('immediate','digest_daily')`
    ),
    severityCheck: check(
      'notification_preferences_severity_check',
      sql`${t.minSeverity} IN ('info','warning','critical')`
    ),
    uniquePreference: uniqueIndex('uq_notification_preferences').on(
      t.orgId,
      t.userId,
      t.alertType,
      t.channel
    ),
  })
)
