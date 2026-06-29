// IMMUTABLE (insert-only) EXCEPT the retention cryptographic-purge UPDATE.
// No updated_at column and NO append-only trigger: the retention job must be able to
// overwrite encrypted_value with zeros and clear key_version (the only sanctioned mutation).
import { pgTable, uuid, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { credentials } from './credentials.js'
import type { EncryptedValue } from '@project-vault/crypto'

export const credentialVersions = pgTable(
  'credential_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    // EncryptedValue JSON: { version, iv, ciphertext, tag }. Nullable so the retention
    // purge can null it out after zeroing. NEVER returned by any list/history response.
    encryptedValue: jsonb('encrypted_value').$type<EncryptedValue | null>(),
    // The vault primary-key version in effect when this value was encrypted. Cleared on purge.
    keyVersion: integer('key_version'),
    // Monotonic per credential, assigned in the app layer under a row lock (see AC-3/AC-5).
    versionNumber: integer('version_number').notNull(),
    // Retention exemption seam: when non-null, this version is locked by an in-progress or
    // stale-recovery rotation (Epic 5) and is exempt from retention deletion. Null in 2.2.
    rotationLockedAt: timestamp('rotation_locked_at', { withTimezone: true }),
    // Set when the version's value has been cryptographically purged by the retention job.
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Enforces version-number uniqueness per credential at the DB layer (prevents races).
    credVersionUnique: uniqueIndex('idx_credential_versions_unique').on(
      t.credentialId,
      t.versionNumber
    ),
    credVersionIdx: index('idx_credential_versions_cred').on(
      t.credentialId,
      t.versionNumber.desc()
    ),
  })
)
