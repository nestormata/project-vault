import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Platform-scoped security events that occur before an org context is known.
// Intentionally has no org_id and no RLS policy; rows must not contain raw subject PII.
export const platformSecurityEvents = pgTable(
  'platform_security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    subjectHash: text('subject_hash'),
    emailDomain: text('email_domain'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    payload: jsonb('payload').notNull().default({}),
    keyVersion: integer('key_version').notNull(),
    hmac: text('hmac').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventTypeIdx: index('idx_platform_security_events_event_type').on(
      t.eventType,
      t.createdAt.desc()
    ),
    subjectHashIdx: index('idx_platform_security_events_subject_hash').on(t.subjectHash),
    createdAtIdx: index('idx_platform_security_events_created_at').on(t.createdAt.desc()),
  })
)

export type PlatformSecurityEvent = typeof platformSecurityEvents.$inferSelect
export type NewPlatformSecurityEvent = typeof platformSecurityEvents.$inferInsert
