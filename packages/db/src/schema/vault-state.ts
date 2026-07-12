// SINGLE ROW TABLE: platform-level state; no org_id; no RLS; exempt from check-rls-coverage
import { pgTable, smallint, integer, text, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * vault_state: exactly one row, enforced by id=1 primary key + CHECK constraint.
 * Platform-level table — NOT org-scoped, NOT subject to RLS.
 *
 * key_version and audit_key_version start at 1 and increment independently on rotation.
 * Old key versions must be retained in a key_history store (Story 9.x) for decrypting
 * audit log entries written under previous key versions.
 */
export const vaultState = pgTable(
  'vault_state',
  {
    // Single-row sentinel: only id=1 is permitted
    id: smallint('id')
      .primaryKey()
      .default(sql`1`),

    // Primary encryption key lifecycle
    keyVersion: integer('key_version').notNull().default(1),

    // Encrypted test sentinel — verifies key correctness at unseal time
    // Stored as JSON.stringify(EncryptedValue): {"version":1,"iv":"...","ciphertext":"...","tag":"..."}
    encryptedSentinel: text('encrypted_sentinel').notNull(),

    // Audit log encryption key lifecycle — independent rotation from primary key
    auditKeyVersion: integer('audit_key_version').notNull().default(1),

    // Story 9.4 D3: platform audit log's OWN key rotation lifecycle — independent from
    // audit_key_version (the org-scoped audit key). Must never be assumed to move together with
    // audit_key_version or key_version (AC-5 edge case).
    platformAuditKeyVersion: integer('platform_audit_key_version').notNull().default(1),

    // Key custody model — see Product Decisions section
    // 'passphrase' = Argon2id KDF (recommended for small teams)
    // 'envelope'   = split key: env half + file half (recommended for production)
    // 'file'       = raw binary key file (downgraded — requires explicit ack)
    // 'kms'        = AWS KMS-wrapped data key (Story 1.14 — most-secure option, no ack required)
    kmsType: text('kms_type').notNull(),

    // Passphrase mode only: Argon2id salt + params for re-derivation at unseal.
    // NULL for envelope/file modes. Never contains the passphrase itself.
    keyDerivationParams: text('key_derivation_params'),

    // Story 1.14: 'kms' mode only. NULL for passphrase/envelope/file modes, both before and
    // after this column was added (AC-7/AC-20 — purely additive, no backfill). kmsKeyId is the
    // KMS key ARN/alias supplied at init (not secret material). kmsEncryptedDek is the
    // base64-encoded CiphertextBlob returned by AWS KMS's GenerateDataKey — safe to store at
    // rest since only the KMS key itself can unwrap it.
    kmsKeyId: text('kms_key_id'),
    kmsEncryptedDek: text('kms_encrypted_dek'),

    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull().defaultNow(),

    // Story 9.2 D8: nullable at the schema level (existing pre-migration rows are backfilled to
    // initialized_at, so in practice this is never NULL after migration), tracks the last time
    // the master key was recorded as rotated. No rotation-execution endpoint exists yet (D8) —
    // this column is set once by the backfill migration and never advanced by this story.
    keyRotatedAt: timestamp('key_rotated_at', { withTimezone: true }),
  },
  (table) => [
    check('vault_state_single_row', sql`${table.id} = 1`),
    check(
      'vault_state_kms_type_check',
      sql`${table.kmsType} IN ('passphrase', 'envelope', 'file', 'kms')`
    ),
  ]
)

export type VaultState = typeof vaultState.$inferSelect
export type NewVaultState = typeof vaultState.$inferInsert
