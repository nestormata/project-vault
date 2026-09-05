import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationQueue = pgTable(
  'notification_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }),
    recipientEmail: text('recipient_email'),
    channel: text('channel').notNull(),
    templateId: text('template_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliverAt: timestamp('deliver_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Story 20.11 AC9 — additive-only columns. `providerId` records which registered
    // `DeliveryProvider` (keyed by channel, see apps/api/src/lib/delivery-provider.ts) handled the
    // send; `null` for the Story 3.1 SMTP default path. `providerMessageId` is the provider's own
    // message identifier, used to resolve an inbound delivery-status webhook event back to this
    // row (unique per provider — enforced by a partial unique index below, since it is only ever
    // set for provider-backed sends). `lastEventAt` tracks the most recent applied status
    // transition (send-time or webhook-applied), for `applyDeliveryStatusUpdate()`'s idempotent
    // same-status branch.
    providerId: text('provider_id'),
    providerMessageId: text('provider_message_id'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  },
  (t) => ({
    channelCheck: check(
      'notification_queue_channel_check',
      sql`${t.channel} IN ('email','slack','inbox')`
    ),
    // Story 20.11 AC2/AC9 — additive-only: `sent`/`bounced` are new, no existing value removed or
    // reinterpreted.
    statusCheck: check(
      'notification_queue_status_check',
      sql`${t.status} IN ('pending','sent','delivered','bounced','failed','suppressed')`
    ),
    providerMessageIdUnique: uniqueIndex('idx_notification_queue_provider_message_id')
      .on(t.providerId, t.providerMessageId)
      .where(sql`${t.providerMessageId} IS NOT NULL`),
    pendingIdx: index('idx_notification_queue_pending')
      .on(t.orgId, t.status)
      .where(sql`${t.status} = 'pending'`),
    createdAtIdx: index('idx_notification_queue_created_at').on(t.createdAt),
  })
)
