import {
  pgTable,
  uuid,
  text,
  customType,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations.js'

// `bytea` has no first-class drizzle-orm/pg-core helper — mirrors the codebase's existing
// pattern for raw binary columns (see e.g. status-page-services.ts's own bytea usage) of
// declaring a minimal customType mapped to Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/**
 * Story 20.8 AC-5 — the dedicated, RLS-isolated, TTL-bounded ephemeral-state table backing
 * `HostServices.ephemeralState`. Never reused for any other extension-owned business data (20-7
 * AC-6). Every row is implicitly namespaced to `(orgId, extensionNamespace, key)` — the unique
 * constraint below is the storage-layer enforcement of that namespacing (AC-4).
 *
 * `valueCiphertext`/`encryptionKeyVersion` mirror this codebase's standard encrypted-column
 * convention (AES-256-GCM via `packages/crypto`, key-version stored alongside ciphertext — see
 * `credential_versions.key_version`), except the full `EncryptedValue` envelope (iv/ciphertext/
 * tag) is serialized into the single `value_ciphertext bytea` column (rather than a separate
 * jsonb column) per this story's AC-5 exact column shape; `encryptionKeyVersion` records the
 * vault primary key's version in effect at write time (`vaultState.keyVersion`, via
 * `currentKeyVersion()`), independent of the ciphertext envelope's own internal format version.
 */
export const extensionEphemeralState = pgTable(
  'extension_ephemeral_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    extensionNamespace: text('extension_namespace').notNull(),
    key: text('key').notNull(),
    valueCiphertext: bytea('value_ciphertext').notNull(),
    encryptionKeyVersion: integer('encryption_key_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_extension_ephemeral_state_unique').on(
      table.orgId,
      table.extensionNamespace,
      table.key
    ),
    // AC-11 — supports the live-count-per-org subquery the per-org cap's advisory-lock-guarded
    // insert runs (org_id, expires_at > now()).
    index('idx_extension_ephemeral_state_org_expiry').on(table.orgId, table.expiresAt),
  ]
)

export type ExtensionEphemeralState = typeof extensionEphemeralState.$inferSelect
export type NewExtensionEphemeralState = typeof extensionEphemeralState.$inferInsert
