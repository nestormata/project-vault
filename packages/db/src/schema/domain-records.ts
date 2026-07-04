import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

// Story 6.1 — domain registration expiry tracking (FR26). See payment-records.ts for the
// alertLeadDays/notifiedLeadDays jsonb-array rationale (ADR-6.1-02). No uniqueness constraint on
// domainName within a project — AC 3 explicitly allows duplicate tracking (e.g. registrar
// renewal vs. DNS provider renewal are two legitimate, independent records).
export const domainRecords = pgTable(
  'domain_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    domainName: text('domain_name').notNull(),
    renewalDate: timestamp('renewal_date', { withTimezone: true }),
    // Default [30] per epics.md AC body for domain registrations (single threshold).
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[30]'::jsonb`)
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
    projectRenewalIdx: index('idx_domain_records_project_renewal').on(t.projectId, t.renewalDate),
    orgIdx: index('idx_domain_records_org').on(t.orgId),
    domainNameLenCheck: check(
      'domain_records_domain_name_len_check',
      sql`char_length(${t.domainName}) BETWEEN 1 AND 256`
    ),
  })
)
