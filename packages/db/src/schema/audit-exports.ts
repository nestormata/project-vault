import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  index,
  check,
  customType,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

/** Raw Postgres `bytea` column — D8: the generated (gzip-compressed) CSV is stored directly in
 * the database rather than provisioning a second, internal object-storage dependency. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const auditExports = pgTable(
  'audit_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    fromDate: timestamp('from_date', { withTimezone: true }).notNull(),
    toDate: timestamp('to_date', { withTimezone: true }).notNull(),
    format: text('format').notNull(),
    includeIntegrityReport: boolean('include_integrity_report').notNull().default(true),
    status: text('status').notNull().default('pending'),
    errorReason: text('error_reason'),
    rowsChecked: integer('rows_checked'),
    integritySummary: jsonb('integrity_summary'),
    // D8 — gzip-compressed CSV bytes; NULL until the job completes successfully.
    fileContent: bytea('file_content'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    orgCreatedIdx: index('idx_audit_exports_org_created').on(t.orgId, t.createdAt.desc()),
    statusCheck: check(
      'audit_exports_status_check',
      sql`${t.status} IN ('pending','processing','completed','failed')`
    ),
    formatCheck: check('audit_exports_format_check', sql`${t.format} IN ('csv')`),
  })
)

export type AuditExport = typeof auditExports.$inferSelect
export type NewAuditExport = typeof auditExports.$inferInsert
