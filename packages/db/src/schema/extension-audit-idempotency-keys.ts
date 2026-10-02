import { pgTable, uuid, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { auditLogEntries } from './audit-log-entries.js'

/**
 * Story 71.1 — dedupe record for `AuditEventSourceHost.writeAuditEvent({ idempotencyKey })`.
 * One row per `(org, extension namespace, key)`; written in the SAME transaction as the audit row
 * it points at, so a rolled-back first write leaves no key behind.
 *
 * Lives in its own table on purpose: `audit_log_entries` is append-only and HMAC-chained, and
 * adding a column there would touch the HMAC input, the chain and the immutability triggers
 * (AC-5). The table stores a content FINGERPRINT (sha256 of canonical JSON), never a copy of the
 * payload, so an extension's secret/field audit payloads are not duplicated into a second,
 * differently-retained table.
 *
 * Retention: a key lives exactly as long as its audit row. `audit_entry_id` cascades on delete, so
 * the sanctioned `purge_expired_audit_log_entries()` retention purge (which does delete audit
 * rows for orgs with a configured retention window) cannot be blocked by this table, and a purged
 * row's key disappears with it. `vault_app` has SELECT/INSERT only; the cascade runs as the table
 * owner. `org_id` has no cascade, mirroring `audit_log_entries` itself.
 */
export const extensionAuditIdempotencyKeys = pgTable(
  'extension_audit_idempotency_keys',
  {
    ...orgScoped(),
    extensionName: text('extension_name').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    auditEntryId: uuid('audit_entry_id')
      .notNull()
      .references(() => auditLogEntries.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.extensionName, t.idempotencyKey] }),
    // Backs the audit_entry_id FK's ON DELETE CASCADE: the retention purge deletes audit rows in
    // bulk, and without this each deleted row would scan the whole key table.
    auditEntryIdx: index('idx_extension_audit_idempotency_keys_audit_entry').on(t.auditEntryId),
  })
)
