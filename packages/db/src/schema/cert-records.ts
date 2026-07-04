import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

// Story 6.1 — SSL/TLS certificate expiry tracking (FR25). See payment-records.ts for the
// alertLeadDays/notifiedLeadDays jsonb-array rationale (ADR-6.1-02).
export const certRecords = pgTable(
  'cert_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Default [30, 7] per AC-E6b (dual-threshold requirement for certificates).
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[30, 7]'::jsonb`)
      .$type<number[]>(),
    notifiedLeadDays: jsonb('notified_lead_days')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<number[]>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectExpiresIdx: index('idx_cert_records_project_expires').on(t.projectId, t.expiresAt),
    orgIdx: index('idx_cert_records_org').on(t.orgId),
    domainLenCheck: check(
      'cert_records_domain_len_check',
      sql`char_length(${t.domain}) BETWEEN 1 AND 256`
    ),
  })
)
