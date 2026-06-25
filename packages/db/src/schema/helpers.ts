import { uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organizations.js'

/**
 * Adds the `org_id` column with a NOT NULL FK to `organizations`.
 * Defaults to no ON DELETE action (matches audit_log_entries/security_alerts,
 * which retain rows on org deletion for audit-trail integrity).
 * Pass onDelete: 'cascade' for tables that should be deleted alongside their org
 * (org_memberships, sessions).
 */
export function orgScoped(opts: { onDelete?: 'cascade' } = {}) {
  return {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, opts.onDelete ? { onDelete: opts.onDelete } : {}),
  }
}
