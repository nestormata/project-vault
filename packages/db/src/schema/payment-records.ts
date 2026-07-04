import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

// Story 6.1 (ADR-6.1-01): architecture.md's canonical schema names this table `payment_records`
// ("hosting providers, payment subscriptions, SaaS tools" — FR24's literal description) while the
// API route stays `/services` (epics.md's literal, already-referenced-by-placeholder-copy path).
// `alertLeadDays`/`notifiedLeadDays` are jsonb number[] (ADR-6.1-02), not architecture.md's single
// `alert_threshold_days` integer — a single column can't represent multi-threshold alerting.
export const paymentRecords = pgTable(
  'payment_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url'),
    renewalDate: timestamp('renewal_date', { withTimezone: true }),
    // Default [14, 3] per epics.md AC-E6b-adjacent body text for services.
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[14, 3]'::jsonb`)
      .$type<number[]>(),
    // Thresholds already alerted for the CURRENT renewalDate; reset to [] whenever renewalDate
    // changes (AC 6) so a new expiry cycle can re-fire the same threshold values.
    notifiedLeadDays: jsonb('notified_lead_days')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<number[]>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRenewalIdx: index('idx_payment_records_project_renewal').on(t.projectId, t.renewalDate),
    orgIdx: index('idx_payment_records_org').on(t.orgId),
    nameLenCheck: check(
      'payment_records_name_len_check',
      sql`char_length(${t.name}) BETWEEN 1 AND 256`
    ),
    urlLenCheck: check(
      'payment_records_url_len_check',
      sql`${t.url} IS NULL OR char_length(${t.url}) BETWEEN 0 AND 2048`
    ),
  })
)
