import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { credentials } from './credentials.js'

// Story 17.3 AC-10/FR125: an append-only record of "rotation-recommended nudge" dismissals — a
// dismissal is its own event row, not an update-in-place flag, so a credential/field's dismissal
// history is itself auditable without duplicating the same data in a separate audit-log entry.
// `field_key` mirrors `credential_shares.field_key`'s single-nullable-text-column convention
// (NULL = whole-credential bucket) rather than `rotations.target_fields`'s array shape, since a
// single dismissal action always targets exactly one bucket at a time.
export const credentialShareNudgeDismissals = pgTable(
  'credential_share_nudge_dismissals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key'),
    dismissedBy: uuid('dismissed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
    // FR125's "explicitly dismissed with a recorded reason" — non-empty enforced at the API layer
    // (422 on empty/whitespace-only), deliberately NOT a DB-level CHECK (see AC-10/Task 1.4: a
    // CHECK violation would surface as a confusing 500 instead of a clean 422).
    reason: text('reason').notNull(),
  },
  (t) => ({
    // AC-10/AC-11: the nudge-computation query's own lookup shape — most-recent dismissal for a
    // given (credentialId, fieldKey) bucket.
    bucketDismissedAtIdx: index('idx_credential_share_nudge_dismissals_bucket').on(
      t.credentialId,
      t.fieldKey,
      t.dismissedAt.desc()
    ),
    orgIdx: index('idx_credential_share_nudge_dismissals_org').on(t.orgId),
  })
)
