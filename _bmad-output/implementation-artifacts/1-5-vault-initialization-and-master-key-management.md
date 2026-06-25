# Story 1.5: Vault Initialization & Master Key Management

Status: review

<!-- Red Team + FMEA hardening 2026-06-24: AC-23–30 (bootstrap, rate limit, log redaction, state sync, fail-fast, vault_corrupted, pg-boss defer, argon2 validation). -->

## Story

As a platform operator starting a fresh vault instance,
I want a guided vault initialization ceremony that establishes master key custody and encrypts the vault,
so that all secrets stored in subsequent operations are encrypted at rest with AES-256-GCM from the first write.

## Acceptance Criteria

*Covers: FR60* [Source: _bmad-output/planning-artifacts/epics.md#Story-1.5]

**Prerequisite:** Story 1.4 is complete, the database is migrated, and `vault_state` does not yet exist.

---

### AC-1: `packages/crypto` Implements Real AES-256-GCM + HKDF

**Given** the current `packages/crypto/src/index.ts` is a stub with `withSecret()` that throws,
**When** Story 1.5 is complete,
**Then** `packages/crypto` provides a fully functional cryptographic layer with **`node:crypto` plus `argon2`** (Argon2id for master passphrase KDF — the only approved third-party crypto dependency).

#### AC-1a: `packages/crypto/src/aes.ts` — AES-256-GCM (internal module)

`aes.ts` is **not exported from `index.ts`** — all callers outside `packages/crypto` use `withSecret()` or `encrypt()`.

```typescript
// packages/crypto/src/aes.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { EncryptedValue } from './types.js'

const IV_BYTES = 12      // 96-bit IV — GCM recommended size
const TAG_BYTES = 16     // 128-bit auth tag — GCM default
const VERSION = 1        // ciphertext format version — increment on algorithm change

export async function encrypt(plaintext: Buffer, key: Buffer): Promise<EncryptedValue> {
  if (key.length !== 32) throw new Error(`aes.encrypt: key must be 32 bytes, got ${key.length}`)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()   // always 16 bytes with GCM default
  return {
    version: VERSION,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

// Internal only — callers outside packages/crypto must use withSecret()
export async function decrypt(encrypted: EncryptedValue, key: Buffer): Promise<Buffer> {
  if (encrypted.version !== VERSION) {
    throw new Error(`aes.decrypt: unsupported version ${encrypted.version}; only version ${VERSION} supported`)
  }
  if (key.length !== 32) throw new Error(`aes.decrypt: key must be 32 bytes, got ${key.length}`)
  const iv = Buffer.from(encrypted.iv, 'hex')
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex')
  const tag = Buffer.from(encrypted.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)   // GCM auth-tag check is constant-time inside OpenSSL
  // decipher.final() throws ERR_CRYPTO_INVALID_AUTH_TAG if tag doesn't match — catch and rethrow clearly
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new Error('Decryption failed: invalid key or corrupted ciphertext', { cause: err })
  }
}
```

**Critical invariants:**
- Random 12-byte IV per `encrypt()` call — never reuse an IV with the same key
- 128-bit auth tag (GCM default) — constant-time comparison handled internally by OpenSSL
- Versioned ciphertext format `{ version, iv, ciphertext, tag }` — from the FIRST write; retrofitting costs a full re-encryption migration
- `decipher.setAuthTag()` + `decipher.final()` throwing = authentication failure (wrong key or tampered data)

#### AC-1b: `packages/crypto/src/kdf.ts` — HKDF-SHA256

```typescript
// packages/crypto/src/kdf.ts
import { hkdfSync } from 'node:crypto'

const KEY_BYTES = 32  // 256-bit AES key

// Canonical info strings — these are the authoritative constants; never hardcode elsewhere
export const HKDF_INFO = {
  PRIMARY:   'project-vault-v1',
  AUDIT_LOG: 'project-vault-audit-log-v1',
  BACKUP:    'project-vault-backup-v1',          // Story 9.1 uses this
  PLATFORM_AUDIT: 'project-vault-platform-audit-v1', // Story 9.4 uses this
} as const

/**
 * Derive a 256-bit AES key from master key material (IKM).
 *
 * @param ikm    - Raw master key bytes (minimum 32 bytes).
 * @param info   - Context string distinguishing derived key purpose (use HKDF_INFO constants).
 * @returns      - 32-byte Buffer containing the derived key.
 *
 * Salt is intentionally empty: RFC 5869 §3.1 states "if not provided, the salt is set to a
 * string of HashLen zeros" which is the defined default. Since IKM is uniformly random (≥32
 * bytes from a cryptographically random key file), the extract step still produces strong
 * pseudorandom key material without a separate salt.
 */
export function deriveKey(ikm: Buffer, info: string): Buffer {
  // hkdfSync(digest, ikm, salt, info, keylen) — Node.js 15.0+ built-in
  return Buffer.from(
    hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info, 'utf8'), KEY_BYTES)
  )
}
```

#### AC-1c: `packages/crypto/src/secret-value.ts` — SecretValue + withSecret

Move `SecretValue` out of `index.ts` into its own module. `withSecret()` now uses real decryption.

```typescript
// packages/crypto/src/secret-value.ts
import { decrypt } from './aes.js'
import type { EncryptedValue } from './types.js'

const REDACTED = '[REDACTED]'

// Module-level active key — injected by vault service at unseal time.
// WHY a module-level key and not a parameter:
//   The architecture mandates withSecret(encrypted, fn) with exactly 2 args (no key param).
//   This allows all call sites to use the API without threading the key through every layer.
//   The vault guard (sealed middleware) ensures withSecret() is never called while sealed,
//   so _activeKey will always be set when withSecret() executes in normal flow.
let _activeKey: Buffer | null = null

export function setVaultKey(key: Buffer): void {
  // Zero previous key before replacing
  if (_activeKey) _activeKey.fill(0)
  _activeKey = Buffer.from(key) // own copy — caller may zero their copy independently
}

export function clearVaultKey(): void {
  if (_activeKey) {
    _activeKey.fill(0)
    _activeKey = null
  }
}

export function isVaultKeySet(): boolean {
  return _activeKey !== null
}

export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  use<T>(fn: (plaintext: string) => T): T {
    return fn(this.#value)
  }

  toJSON(): string { return REDACTED }
  toString(): string { return REDACTED }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return REDACTED }
}

/**
 * Decrypt an encrypted value and pass the plaintext Buffer to fn().
 * The Buffer is zeroed in finally{} — plaintext never outlives the callback.
 *
 * IMPORTANT: Converting Buffer to string inside fn() forfeits zeroing for that copy
 * (JS strings are immutable; Buffer.fill(0) cannot reach them). Document at every call
 * site that performs a string conversion.
 *
 * The ONE permitted conversion: the revelation path in secrets/service.ts
 * (plaintext.toString('utf8') assigned directly to response body, sent immediately).
 * All other call sites must keep the plaintext as Buffer.
 */
export async function withSecret<T>(
  encrypted: EncryptedValue,
  fn: (plaintext: Buffer) => Promise<T>
): Promise<T> {
  if (!_activeKey) {
    throw new Error('withSecret: vault is sealed — ensure vault is unsealed before accessing secrets')
  }
  const plaintext = await decrypt(encrypted, _activeKey)
  try {
    return await fn(plaintext)
  } finally {
    plaintext.fill(0)
  }
}
```

#### AC-1d: `packages/crypto/src/types.ts` — shared type

```typescript
// packages/crypto/src/types.ts
export type EncryptedValue = {
  version: number
  iv: string         // hex
  ciphertext: string // hex
  tag: string        // hex
}
```

#### AC-1f: `packages/crypto/src/passwords.ts` — Argon2id Master Passphrase KDF

**Product decision:** v1 primary custody model is **passphrase + KDF** (not raw binary files). User passwords in Story 1.6 reuse the same module.

Add `argon2` as the **only** third-party runtime dependency in `packages/crypto` (architecture-approved for Argon2id).

```typescript
// packages/crypto/src/passwords.ts
import argon2 from 'argon2'
import { randomBytes } from 'node:crypto'

/** Canonical Argon2id params — shared with Story 1.6 user password hashing. */
export const ARGON2_PARAMS = {
  memoryCost: 65536,  // 64 MiB
  timeCost: 3,
  parallelism: 4,
  type: argon2.argon2id,
  hashLength: 32,     // 256-bit output used directly as HKDF IKM
} as const

export type KeyDerivationParams = {
  type: 'argon2id'
  salt: string       // hex-encoded 16-byte random salt
  memoryCost: number
  timeCost: number
  parallelism: number
}

/** Generate new random salt + params for vault init (passphrase mode). */
export function createKeyDerivationParams(): KeyDerivationParams {
  return {
    type: 'argon2id',
    salt: randomBytes(16).toString('hex'),
    memoryCost: ARGON2_PARAMS.memoryCost,
    timeCost: ARGON2_PARAMS.timeCost,
    parallelism: ARGON2_PARAMS.parallelism,
  }
}

/**
 * Derive 32-byte IKM from master passphrase using Argon2id.
 * Passphrase Buffer is zeroed by caller after use — this function does not retain it.
 */
export async function deriveIkmFromPassphrase(
  passphrase: string,
  params: KeyDerivationParams
): Promise<Buffer> {
  if (params.type !== 'argon2id') {
    throw new Error(`deriveIkmFromPassphrase: unsupported type ${params.type}`)
  }
  const hash = await argon2.hash(passphrase, {
    ...ARGON2_PARAMS,
    salt: Buffer.from(params.salt, 'hex'),
    raw: true,  // return Buffer, not encoded string
  })
  return Buffer.from(hash)
}
```

**Passphrase rules (init + unseal):**
- Minimum **12 characters** (align with Story 1.6 registration)
- Passphrase **never** logged, stored in DB, or returned in responses
- Passphrase supplied in JSON body only over TLS — document in operator runbook

#### AC-1g: `packages/crypto/src/envelope.ts` — Split-Key Combination (Minimal Envelope Mode)

**Product decision:** v1 includes **minimal envelope mode** — half from env var, half from mounted file; neither half alone derives the vault key.

```typescript
// packages/crypto/src/envelope.ts
import { randomBytes } from 'node:crypto'

const ENVELOPE_HALF_BYTES = 16  // 128-bit half → 256-bit IKM when concatenated

/**
 * Combine env half + file half into 32-byte IKM via concatenation.
 * Architecture: neither half is sufficient alone; both required at init/unseal.
 */
export function combineEnvelopeHalves(envHalf: Buffer, fileHalf: Buffer): Buffer {
  if (envHalf.length !== ENVELOPE_HALF_BYTES || fileHalf.length !== ENVELOPE_HALF_BYTES) {
    throw new Error(
      `combineEnvelopeHalves: each half must be ${ENVELOPE_HALF_BYTES} bytes, ` +
      `got env=${envHalf.length} file=${fileHalf.length}`
    )
  }
  return Buffer.concat([envHalf, fileHalf])
}

/** Parse VAULT_ENVELOPE_KEY_HALF env value: 32 lowercase hex chars → 16 bytes. */
export function parseEnvelopeEnvHalf(hex: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error('VAULT_ENVELOPE_KEY_HALF must be exactly 32 lowercase hex characters (16 bytes)')
  }
  return Buffer.from(hex, 'hex')
}
```

**Envelope file half:** exactly **16 bytes** read from `envelopeKeyPath` within `VAULT_KEY_DIR` (same path confinement as file mode).

**Env half:** `VAULT_ENVELOPE_KEY_HALF` — 32 hex chars (16 bytes). Set at deploy time; **not** stored in DB.

**Generate halves for operators:**

```bash
# Env half (store in secrets manager / compose env, NOT in git)
openssl rand -hex 16   # → paste into VAULT_ENVELOPE_KEY_HALF

# File half (store on separate volume mount)
openssl rand -out dev-secrets/envelope-half.bin 16
```

#### AC-1h: Updated `packages/crypto/src/index.ts` exports

Add to public exports:

```typescript
export { deriveIkmFromPassphrase, createKeyDerivationParams, ARGON2_PARAMS } from './passwords.js'
export type { KeyDerivationParams } from './passwords.js'
export { combineEnvelopeHalves, parseEnvelopeEnvHalf } from './envelope.js'
```

**Custody model summary (IKM → HKDF → primary + audit keys):**

| `kms_type` | IKM source | Stored in DB |
|---|---|---|
| `passphrase` | Argon2id(passphrase, salt, params) | `key_derivation_params` JSON (salt + Argon2 params) |
| `envelope` | concat(env_half, file_half) | nothing about halves — operator must preserve both |
| `file` | raw bytes from key file (≥32) | nothing — **downgraded mode**, requires explicit ack |

---

The public API surface of the package. `decrypt()` is **NOT exported** — only `withSecret()` provides access to plaintext.

```typescript
// packages/crypto/src/index.ts
// Public types
export type { EncryptedValue } from './types.js'

// Public encryption API — encrypt IS exported (plaintext is the INPUT, not leaked output)
export { encrypt } from './aes.js'

// Key derivation
export { deriveKey, HKDF_INFO } from './kdf.js'

// Safe decryption + vault key lifecycle
export {
  withSecret,
  SecretValue,
  setVaultKey,
  clearVaultKey,
  isVaultKeySet,
} from './secret-value.js'

// NOTE: decrypt() from aes.ts is NOT re-exported for general use.
// All plaintext access goes through withSecret() which zeros the buffer in finally.
// The no-bare-decrypt ESLint rule enforces this at compile time.
//
// EXCEPTION: bootstrapDecrypt is the ONLY export of the raw decrypt function.
// It is permitted ONLY in apps/api/src/modules/vault/key-service.ts (unseal bootstrap,
// where the module-level key is not yet set and withSecret() cannot be used).
// The no-bare-decrypt ESLint rule must allow bootstrapDecrypt in key-service.ts explicitly.
export { decrypt as bootstrapDecrypt } from './aes.js'
```

**All existing tests in `packages/crypto/src/index.test.ts` must be updated** — the `withSecret` stub test that expects a throw must be replaced with the real implementation tests (see AC-11).

---

### AC-2: `vault_state` Drizzle Schema and Migration

**Given** the database has Story 1.4's initial schema,
**When** `pnpm --filter @project-vault/db db:migrate` runs,
**Then** a `vault_state` table exists with exactly the schema below.

#### AC-2a: Drizzle Schema

```typescript
// packages/db/src/schema/vault-state.ts
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
    id: smallint('id').primaryKey().default(sql`1`),

    // Primary encryption key lifecycle
    keyVersion: integer('key_version').notNull().default(1),

    // Encrypted test sentinel — verifies key correctness at unseal time
    // Stored as JSON.stringify(EncryptedValue): {"version":1,"iv":"...","ciphertext":"...","tag":"..."}
    encryptedSentinel: text('encrypted_sentinel').notNull(),

    // Audit log encryption key lifecycle — independent rotation from primary key
    auditKeyVersion: integer('audit_key_version').notNull().default(1),

    // Key custody model — see Product Decisions section
    // 'passphrase' = Argon2id KDF (recommended for small teams)
    // 'envelope'   = split key: env half + file half (recommended for production)
    // 'file'       = raw binary key file (downgraded — requires explicit ack)
    kmsType: text('kms_type').notNull(),

    // Passphrase mode only: Argon2id salt + params for re-derivation at unseal.
    // NULL for envelope/file modes. Never contains the passphrase itself.
    keyDerivationParams: text('key_derivation_params'),  // JSON.stringify(KeyDerivationParams)

    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('vault_state_single_row', sql`${table.id} = 1`),
    check('vault_state_kms_type_check', sql`${table.kmsType} IN ('passphrase', 'envelope', 'file', 'kms')`),
  ]
)

export type VaultState = typeof vaultState.$inferSelect
export type NewVaultState = typeof vaultState.$inferInsert
```

Export from `packages/db/src/schema/index.ts`:
```typescript
// Add to packages/db/src/schema/index.ts
export * from './vault-state.js'
```

#### AC-2b: Migration File

Create `packages/db/src/migrations/0002_vault_state.sql`:

```sql
-- Migration 0002: vault_state table
-- Platform-level single-row table; no org_id; no RLS required.
-- This table must be added to check-rls-coverage.ts allow-list.

CREATE TABLE vault_state (
  id               SMALLINT    PRIMARY KEY DEFAULT 1,
  key_version      INTEGER     NOT NULL DEFAULT 1,
  encrypted_sentinel TEXT       NOT NULL,
  audit_key_version INTEGER    NOT NULL DEFAULT 1,
  kms_type         TEXT        NOT NULL,
  key_derivation_params TEXT,   -- JSON; non-null only when kms_type = 'passphrase'
  initialized_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT vault_state_single_row CHECK (id = 1),
  CONSTRAINT vault_state_kms_type_check CHECK (kms_type IN ('passphrase', 'envelope', 'file', 'kms'))
);

COMMENT ON TABLE vault_state IS
  'Single-row platform table. Stores encrypted sentinel for key verification at unseal. '
  'No org_id — not subject to RLS. Exempt from check-rls-coverage.';

COMMENT ON COLUMN vault_state.encrypted_sentinel IS
  'JSON-encoded EncryptedValue of the sentinel string. Decryption success = correct key. '
  'Sentinel plaintext: ''project-vault-sentinel-v1''.';

COMMENT ON COLUMN vault_state.audit_key_version IS
  'Independent lifecycle from key_version. Both start at 1 and rotate separately. '
  'Old audit key versions must be retained in key_history (Story 9.x) for decrypting '
  'audit_log_entries written under previous key versions.';

-- Append-only: prevent vault_state tampering after init (Red Team hardening).
-- UPDATE/DELETE would allow replacing encrypted_sentinel with attacker-controlled ciphertext.
CREATE OR REPLACE FUNCTION vault_state_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vault_state is append-only — UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vault_state_no_update
  BEFORE UPDATE ON vault_state
  FOR EACH ROW EXECUTE FUNCTION vault_state_immutable();

CREATE TRIGGER vault_state_no_delete
  BEFORE DELETE ON vault_state
  FOR EACH ROW EXECUTE FUNCTION vault_state_immutable();
```

**Add `vault_state` to the `check-rls-coverage.ts` allow-list** in `packages/db/src/check-rls-coverage.ts` — the `EXCLUDED_TABLES` constant (currently only `'api_instances'` from Story 1.4). `vault_state` has no `org_id` column and must not trigger a false-positive RLS gap failure. The CLI wrapper at `scripts/check-rls-coverage.ts` imports this module unchanged.

---

### AC-3: Vault Key Service — Init Path (Three Custody Models)

**Given** no `vault_state` row exists in the database,
**When** `POST /api/v1/vault/init` is called with one of the three custody payloads below,
**Then** the API derives IKM, runs HKDF, encrypts the sentinel, persists `vault_state`, and unseals.

#### Mode A — Passphrase (recommended for small teams / dev)

**Request:**
```json
{
  "kmsType": "passphrase",
  "passphrase": "correct-horse-battery-staple"
}
```

**Steps:**
1. Validate passphrase length ≥ 12 → else `400 { error: "invalid_passphrase", message: "Passphrase must be at least 12 characters" }`
2. `params = createKeyDerivationParams()` — random 16-byte salt
3. `ikm = await deriveIkmFromPassphrase(passphrase, params)` — zero passphrase from memory ASAP after derive
4. `primaryKey = deriveKey(ikm, HKDF_INFO.PRIMARY)`; `auditKey = deriveKey(ikm, HKDF_INFO.AUDIT_LOG)`; `ikm.fill(0)`
5. Encrypt sentinel → store row with `kms_type: 'passphrase'`, `key_derivation_params: JSON.stringify(params)`
6. Return `200 { initialized: true, keyVersion: 1, kmsType: "passphrase" }`

#### Mode B — Envelope (recommended for production)

**Request:**
```json
{
  "kmsType": "envelope",
  "envelopeKeyPath": "/run/secrets/envelope-half.bin",
  "acknowledgeSplitKeyModel": true
}
```

**Steps:**
1. Require `acknowledgeSplitKeyModel === true` → else `400 { error: "acknowledgment_required", message: "Envelope mode requires acknowledgeSplitKeyModel: true" }`
2. Read env half from `env.VAULT_ENVELOPE_KEY_HALF` via `parseEnvelopeEnvHalf()` — missing/invalid → `503 { error: "envelope_env_half_missing", message: "VAULT_ENVELOPE_KEY_HALF is not configured" }`
3. Read file half from `envelopeKeyPath` (16 bytes, `VAULT_KEY_DIR` confinement) → `readEnvelopeFileHalf()`
4. `ikm = combineEnvelopeHalves(envHalf, fileHalf)`; zero halves after use
5. HKDF → encrypt sentinel → store with `kms_type: 'envelope'`, `key_derivation_params: null`
6. Return `200 { initialized: true, keyVersion: 1, kmsType: "envelope" }`

#### Mode C — File (downgraded — not recommended)

**Request:**
```json
{
  "kmsType": "file",
  "masterKeyPath": "/run/secrets/vault-key.bin",
  "acknowledgeCoLocationRisk": true
}
```

**Steps:** Same as original file-based flow (≥32 raw bytes) but require `acknowledgeCoLocationRisk: true`.
Store `kms_type: 'file'`. Response includes `"kmsType": "file"`.

**Common init invariants (all modes):**
- **Bootstrap gate (AC-23):** First init rejected unless bootstrap token valid OR `VAULT_ALLOW_REMOTE_INIT=true`
- `INSERT ... ON CONFLICT DO NOTHING` for TOCTOU-safe single-row insert
- If row exists → `409 { error: "already_initialized", ... }`
- Master key material **never** in logs, DB (except `key_derivation_params` salt for passphrase mode), or responses
- Structured log: `{ event: 'vault.init', keyVersion: 1, kmsType: '<mode>' }` — no paths, no passphrases

---

### AC-4: Vault Key Service — Unseal Path (Mode-Aware)

**Given** a `vault_state` row exists and the vault is in `sealed` state,
**When** `POST /api/v1/vault/unseal` is called with credentials matching the stored `kms_type`,
**Then** the API re-derives IKM, verifies the sentinel, injects keys, and transitions to `unsealed`.

**The server reads `vault_state.kms_type` and validates the request body contains the required fields for that mode** — the client does not send `kmsType` on unseal.

| Stored `kms_type` | Unseal request body | IKM derivation |
|---|---|---|
| `passphrase` | `{ "passphrase": "..." }` | Argon2id using stored `key_derivation_params` |
| `envelope` | `{ "envelopeKeyPath": "/run/secrets/envelope-half.bin" }` | `combineEnvelopeHalves(env.VAULT_ENVELOPE_KEY_HALF, fileHalf)` |
| `file` | `{ "masterKeyPath": "/run/secrets/vault-key.bin" }` | raw file bytes (≥32) |

**Steps (all modes):**
1. If already unsealed → `400 { error: "already_unsealed", ... }`
2. Load `vault_state` row; if missing → `400 { error: "not_initialized", ... }`
3. Derive IKM per mode (see table) — zero all intermediate buffers after HKDF
4. `bootstrapDecrypt(storedSentinel, primaryKey)` — failure → `401 { error: "unseal_failed", message: "Vault unseal failed: credentials do not match stored vault configuration." }`
5. `setVaultKey(primaryKey)` + store audit key; `_status = 'unsealed'`
6. Return `200 { unsealed: true, keyVersion: N, kmsType: "<stored>" }`

**Passphrase-specific errors:**
- Passphrase < 12 chars → `400 { error: "invalid_passphrase", ... }`
- Wrong passphrase (GCM tag mismatch) → `401 { error: "unseal_failed", ... }` — same message as wrong file/envelope (no oracle)

**Envelope-specific errors:**
- `VAULT_ENVELOPE_KEY_HALF` missing at unseal → `503 { error: "envelope_env_half_missing", ... }`
- File half wrong size → `400 { error: "invalid_key_file", ... }`

**And** `/ready` transitions from `503` to `200` immediately after successful unseal.

**And** route handler logs `{ event: 'vault.unseal', keyVersion: N, kmsType }` — never logs passphrase, paths, or key material.

---

### AC-5: Sealed Middleware (Vault Guard)

**Given** the vault is in `uninitialized` or `sealed` state,
**When** any HTTP request arrives at any route OTHER than the allow-listed routes,
**Then** the Fastify `onRequest` hook returns `503` before the route handler executes.

**Allow-listed routes (pass through regardless of vault state):**
```
GET  /health
GET  /ready
POST /api/v1/vault/init
POST /api/v1/vault/unseal
```

**Response body for sealed vault:**
```json
{ "status": "sealed", "message": "Vault not initialized" }
```
HTTP status: `503`

**Two distinct sealed sub-states — both return 503, but `/ready` distinguishes them:**

| Sub-state | Vault Status | `/ready` response |
|---|---|---|
| `uninitialized` | No `vault_state` row | `503 { "status": "unavailable", "reason": "sealed", "message": "Vault not initialized. POST /api/v1/vault/init to initialize." }` |
| `sealed` | Row exists, no key in memory | `503 { "status": "unavailable", "reason": "sealed", "message": "Manual unseal required via POST /api/v1/vault/unseal" }` |

**Auto-unseal on crash is explicitly out of v1 scope.** On SIGKILL/OOM/crash, the process terminates and on restart enters `sealed` state regardless of whether `vault_state` exists. The operator must call `POST /api/v1/vault/unseal` before any endpoints become available. This is documented in the API response to `/ready` while sealed.

**Implementation pattern:**
```typescript
// apps/api/src/plugins/vault-guard.ts
import type { FastifyApp } from '../lib/fastify-app.js'
import { getVaultStatus } from '../modules/vault/key-service.js'

/** Normalize path: strip query string, remove trailing slash (except root "/"). */
function normalizePath(rawUrl: string): string {
  const path = rawUrl.split('?')[0] ?? rawUrl
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

// Exact path+method pairs that bypass the vault guard
const VAULT_GUARD_ALLOWLIST = new Set([
  'GET /health',
  'GET /ready',
  'POST /api/v1/vault/init',
  'POST /api/v1/vault/unseal',
])

export async function vaultGuardPlugin(fastify: FastifyApp): Promise<void> {
  fastify.addHook('onRequest', async (req, reply) => {
    const path = normalizePath(req.url)
    const routeKey = `${req.method} ${path}`
    if (VAULT_GUARD_ALLOWLIST.has(routeKey)) return

    const vaultStatus = getVaultStatus()
    if (vaultStatus !== 'unsealed') {
      return reply.status(503).send({ status: 'sealed', message: 'Vault not initialized' })
    }
  })
}
```

**Trailing slash (product decision):** `GET /health/` and `GET /ready/` MUST pass while sealed — `normalizePath()` strips the trailing slash before allowlist lookup.

**Examples:**
```bash
curl -s http://localhost:3000/health/   # → 200 (normalized to /health)
curl -s http://localhost:3000/ready/  # → 503 while sealed (normalized to /ready)
```

**CRITICAL: `vaultGuardPlugin` must NOT be registered in `generate-spec.ts`** dry-run mode (see AC-13).

---

### AC-6: `POST /api/v1/vault/init` and `/unseal` Routes

```typescript
// apps/api/src/modules/vault/schema.ts
import { z } from 'zod/v4'

const PassphraseInitSchema = z.object({
  kmsType: z.literal('passphrase'),
  passphrase: z.string().min(12, 'Passphrase must be at least 12 characters'),
})

const EnvelopeInitSchema = z.object({
  kmsType: z.literal('envelope'),
  envelopeKeyPath: z.string().min(1),
  acknowledgeSplitKeyModel: z.literal(true, {
    error: 'Envelope mode requires acknowledgeSplitKeyModel: true',
  }),
})

const FileInitSchema = z.object({
  kmsType: z.literal('file'),
  masterKeyPath: z.string().min(1),
  acknowledgeCoLocationRisk: z.literal(true, {
    error: 'File mode requires acknowledgeCoLocationRisk: true — not recommended for production',
  }),
})

export const VaultInitRequestSchema = z.discriminatedUnion('kmsType', [
  PassphraseInitSchema,
  EnvelopeInitSchema,
  FileInitSchema,
])

export const VaultInitResponseSchema = z.object({
  initialized: z.literal(true),
  keyVersion: z.number().int().positive(),
  kmsType: z.enum(['passphrase', 'envelope', 'file']),
})

/** Unseal body — fields validated server-side against stored kms_type. */
export const VaultUnsealRequestSchema = z.object({
  passphrase: z.string().min(12).optional(),
  envelopeKeyPath: z.string().min(1).optional(),
  masterKeyPath: z.string().min(1).optional(),
}).refine(
  (body) =>
    [body.passphrase, body.envelopeKeyPath, body.masterKeyPath].filter(Boolean).length === 1,
  { message: 'Provide exactly one of: passphrase, envelopeKeyPath, or masterKeyPath' }
)

export const VaultUnsealResponseSchema = z.object({
  unsealed: z.literal(true),
  keyVersion: z.number().int().positive(),
  kmsType: z.enum(['passphrase', 'envelope', 'file']),
})
```

```typescript
// apps/api/src/modules/vault/routes.ts — init handler dispatches by kmsType
const result = await initVault(req.body)  // key-service accepts discriminated union
req.log.info(
  { event: 'vault.init', keyVersion: result.keyVersion, kmsType: result.kmsType },
  'Vault initialized successfully'
)

// unseal handler — key-service reads stored kms_type and validates matching credential field
const result = await unsealVault(req.body)
```

**NOTE**: Routes are NOT wrapped in `SecureRoute`. Network/firewall restriction is the v1 auth layer (product decision). Document in operator runbook.

---

### AC-7: `apps/api/src/modules/vault/key-service.ts` — State Machine

The key service manages the in-memory vault lifecycle. It is the only module that holds derived key buffers.

```typescript
// apps/api/src/modules/vault/key-service.ts
import { lstatSync, openSync, readSync, closeSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { getDb } from '@project-vault/db'
import {
  encrypt,
  deriveKey,
  HKDF_INFO,
  setVaultKey,
  clearVaultKey,
  bootstrapDecrypt,
} from '@project-vault/crypto'
import { vaultState } from '@project-vault/db/schema'
import type { EncryptedValue } from '@project-vault/crypto'
import { AppError } from '../../lib/errors.js'

// Three vault states (architectural invariant — do not add more):
// 'uninitialized' → no vault_state row; only POST /vault/init is allowed
// 'sealed'        → vault_state row exists; only POST /vault/unseal is allowed
// 'unsealed'      → key in memory; all endpoints available
type VaultStatus = 'uninitialized' | 'sealed' | 'unsealed'

let _status: VaultStatus = 'uninitialized'
let _auditKey: Buffer | null = null   // separate from _activeKey in packages/crypto

export function getVaultStatus(): VaultStatus { return _status }
export function isSealed(): boolean { return _status !== 'unsealed' }

/** Call at API startup and after any vault_state truncate — syncs _status with DB. */
export async function loadInitialVaultState(): Promise<VaultStatus> {
  try {
    const db = getDb()
    const rows = await db.select().from(vaultState).limit(1)
    _status = rows.length === 0 ? 'uninitialized' : 'sealed'
    return _status
  } catch (err) {
    process.stderr.write(
      '[vault] FATAL: cannot read vault_state — verify DATABASE_URL and PostgreSQL connectivity.\n'
    )
    throw err
  }
}

const MAX_KEY_FILE_BYTES = 4096  // no legitimate key file needs more than this
const ENVELOPE_HALF_BYTES = 16

/**
 * Read a key-material file from VAULT_KEY_DIR with hardening against symlinks and non-regular files.
 * Uses lstatSync (no follow) then openSync with O_NOFOLLOW where supported.
 */
function readKeyMaterialFile(filePath: string, expectedBytes: number | { min: number; max: number }): Buffer {
  const allowedDir = resolve(env.VAULT_KEY_DIR)
  const resolved = resolve(filePath)
  if (!resolved.startsWith(allowedDir + '/') && resolved !== allowedDir) {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }

  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(resolved)  // lstat — do NOT follow symlinks
  } catch {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }

  // Reject symlinks, directories, FIFOs, devices — only regular files
  if (!stat.isFile()) {
    throw new AppError('INVALID_KEY_FILE', 'Key path must be a regular file, not a symlink or special file', 400)
  }

  const size = stat.size
  if (size > MAX_KEY_FILE_BYTES) {
    throw new AppError('INVALID_KEY_FILE', `Key file exceeds maximum allowed size (${MAX_KEY_FILE_BYTES} bytes)`, 400)
  }

  const expectedMin = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes.min
  const expectedMax = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes.max
  if (size < expectedMin || size > expectedMax) {
    throw new AppError(
      'INVALID_KEY_FILE',
      `Key file must be ${expectedMin}${expectedMax !== expectedMin ? `–${expectedMax}` : ''} bytes, got ${size}`,
      400
    )
  }

  // O_NOFOLLOW prevents TOCTOU symlink swap between stat and read (Linux)
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return readSync(fd, Buffer.alloc(size), 0, size, 0)
  } finally {
    closeSync(fd)
  }
}

/** File mode: raw binary key file ≥ 32 bytes. */
function readKeyFile(masterKeyPath: string): Buffer {
  return readKeyMaterialFile(masterKeyPath, { min: 32, max: MAX_KEY_FILE_BYTES })
}

/** Envelope mode: exactly 16-byte file half. */
function readEnvelopeFileHalf(envelopeKeyPath: string): Buffer {
  return readKeyMaterialFile(envelopeKeyPath, ENVELOPE_HALF_BYTES)
}

export async function initVault(
  masterKeyPath: string
): Promise<{ initialized: true; keyVersion: number }> {
  const db = getDb()
  const keyMaterial = readKeyFile(masterKeyPath)

  // Derive both keys from the same IKM
  const primaryKey = deriveKey(keyMaterial, HKDF_INFO.PRIMARY)
  const auditKey = deriveKey(keyMaterial, HKDF_INFO.AUDIT_LOG)

  // Zero raw key material — never needed again
  keyMaterial.fill(0)

  // Encrypt sentinel with primary key
  const sentinel = Buffer.from('project-vault-sentinel-v1', 'utf8')
  const encryptedSentinel: EncryptedValue = await encrypt(sentinel, primaryKey)
  sentinel.fill(0) // zero the known-plaintext

  // INSERT ON CONFLICT DO NOTHING: atomic check-then-insert eliminates TOCTOU race.
  // If vault_state id=1 already exists, inserted.length === 0 → 409.
  const inserted = await db
    .insert(vaultState)
    .values({
      id: 1,
      keyVersion: 1,
      auditKeyVersion: 1,
      encryptedSentinel: JSON.stringify(encryptedSentinel),
      kmsType: 'file',
    })
    .onConflictDoNothing()
    .returning()

  if (inserted.length === 0) {
    // Another concurrent init won the race — zero derived keys before throwing
    primaryKey.fill(0)
    auditKey.fill(0)
    throw new AppError(
      'ALREADY_INITIALIZED',
      'Vault is already initialized. Use POST /api/v1/vault/unseal to unseal.',
      409
    )
  }

  // Inject primary key into packages/crypto module-level store
  setVaultKey(primaryKey)
  primaryKey.fill(0) // setVaultKey takes its own copy — zero this reference

  // Store audit key separately in this module
  if (_auditKey) _auditKey.fill(0)
  _auditKey = auditKey

  _status = 'unsealed'
  return { initialized: true, keyVersion: 1 }
}

export async function unsealVault(
  masterKeyPath: string
): Promise<{ unsealed: true; keyVersion: number }> {
  if (_status === 'unsealed') {
    throw new AppError('ALREADY_UNSEALED', 'Vault is already unsealed.', 400)
  }

  const db = getDb()
  const rows = await db.select().from(vaultState).limit(1)
  if (rows.length === 0) {
    throw new AppError(
      'NOT_INITIALIZED',
      'Vault has not been initialized. Use POST /api/v1/vault/init first.',
      400
    )
  }
  const state = rows[0]!

  const keyMaterial = readKeyFile(masterKeyPath)

  // Derive primary key and verify against stored sentinel
  const primaryKey = deriveKey(keyMaterial, HKDF_INFO.PRIMARY)
  const auditKey = deriveKey(keyMaterial, HKDF_INFO.AUDIT_LOG)

  // Zero raw key material
  keyMaterial.fill(0)

  // Verify key by decrypting sentinel (static import — compile-time checked, not fragile dynamic path)
  let sentinelDecrypted: Buffer
  try {
    const encryptedSentinel: EncryptedValue = JSON.parse(state.encryptedSentinel)
    sentinelDecrypted = await bootstrapDecrypt(encryptedSentinel, primaryKey)
  } catch (err) {
    primaryKey.fill(0)
    auditKey.fill(0)
    throw new AppError(
      'UNSEAL_FAILED',
      'Vault unseal failed: key file does not match stored vault configuration.',
      401
    )
  }

  // Verify sentinel plaintext (additional guard — should be guaranteed by GCM)
  const expectedSentinel = Buffer.from('project-vault-sentinel-v1', 'utf8')
  if (!sentinelDecrypted.equals(expectedSentinel)) {
    primaryKey.fill(0)
    auditKey.fill(0)
    sentinelDecrypted.fill(0)
    throw new AppError('UNSEAL_FAILED', 'Vault unseal failed: sentinel mismatch.', 401)
  }
  sentinelDecrypted.fill(0)
  expectedSentinel.fill(0)

  // Inject keys
  setVaultKey(primaryKey)
  primaryKey.fill(0) // setVaultKey owns a copy

  if (_auditKey) _auditKey.fill(0)
  _auditKey = auditKey

  _status = 'unsealed'
  return { unsealed: true, keyVersion: state.keyVersion }
}

/** Returns a copy of the audit log encryption key. Throws if vault is sealed. */
export function getAuditKey(): Buffer {
  if (!_auditKey || _status !== 'unsealed') {
    throw new Error('getAuditKey: vault is sealed — audit key unavailable')
  }
  // Return a copy — caller may zero their copy freely without zeroing the module-level key
  return Buffer.from(_auditKey)
}

/** Called by shutdown.ts to zero in-memory keys before process exit. */
export function zeroKeys(): void {
  clearVaultKey()
  if (_auditKey) {
    _auditKey.fill(0)
    _auditKey = null
  }
  _status = 'sealed'
}
```

> **Note on `bootstrapDecrypt` import**: The `unsealVault` function needs direct access to `decrypt()` from `aes.ts` because it cannot use `withSecret()` (the module-level key isn't set yet during unseal). Rather than a fragile `await import('@project-vault/crypto/internal/aes')` dynamic path, `decrypt` is re-exported from `packages/crypto/index.ts` under the alias `bootstrapDecrypt` — a static import that is compile-time verified. The key service is the only caller permitted to use `bootstrapDecrypt` — enforced by the `no-bare-decrypt` ESLint rule's `except-modules` configuration (see Dev Notes).

---

### AC-8: Updated `GET /ready` Reflects Vault State

**Given** the vault is sealed,
**When** `GET /ready` is called,
**Then** it returns `503` with vault-specific reason:

```typescript
// Updated apps/api/src/routes/health.ts
fastify.get('/ready', async (_req, reply) => {
  const vaultStatus = getVaultStatus()

  if (vaultStatus === 'uninitialized') {
    return reply.status(503).send({
      status: 'unavailable',
      reason: 'sealed',
      message: 'Vault not initialized. POST /api/v1/vault/init to initialize.',
    })
  }

  if (vaultStatus === 'sealed') {
    return reply.status(503).send({
      status: 'unavailable',
      reason: 'sealed',
      message: 'Manual unseal required via POST /api/v1/vault/unseal',
    })
  }

  // Vault unsealed — check DB connectivity
  if (!options.dbPool) {
    return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
  }
  try {
    await options.dbPool.query('SELECT 1')
    return reply.send({ status: 'ready' })
  } catch {
    return reply.status(503).send({ status: 'unavailable', reason: 'db', retryAfter: 5 })
  }
})
```

**`GET /health` is vault-state-agnostic** — it always returns `200 { status: 'ok', version: '...' }` regardless of seal state. This lets load balancers and liveness probes pass even while sealed.

---

### AC-9: Memory Zeroing on Shutdown

**Given** the process receives SIGTERM or SIGINT,
**When** the shutdown sequence runs,
**Then** in-memory key buffers are zeroed BEFORE `fastify.close()` is called:

```typescript
// Updated apps/api/src/lib/shutdown.ts
import type { FastifyApp } from './fastify-app.js'
import { zeroKeys } from '../modules/vault/key-service.js'

export function registerShutdown(fastify: FastifyApp): void {
  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, 'Received shutdown signal')
    try {
      // CRITICAL: zero all in-memory key material FIRST
      // This prevents a process core dump from containing derived key bytes
      zeroKeys()
      await fastify.close()
      process.exit(0)
    } catch (err) {
      fastify.log.error(err, 'Error during shutdown')
      // Still zero keys even if shutdown sequence fails
      zeroKeys()
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
```

---

### AC-10: Updated `apps/api/src/main.ts` Startup Sequence

The startup sequence must check vault state BEFORE accepting any traffic:

```typescript
// Updated apps/api/src/main.ts
import { createEventEmitter } from './lib/events.js'
import { createApp } from './app.js'
import { BossService } from './lib/boss.js'
import { registerShutdown } from './lib/shutdown.js'
import { loadInitialVaultState, setOnVaultUnsealed, getVaultStatus } from './modules/vault/key-service.js'
import { env } from './config/env.js'
import postgres from 'postgres'

async function main(): Promise<void> {
  const emitter = createEventEmitter()
  const _ringBuffer = null  // Story 1.11

  const sql = postgres(env.DATABASE_URL)

  // Check vault state from DB before starting server — throws if DB unreachable (AC-27)
  const initialVaultStatus = await loadInitialVaultState()
  process.stderr.write(`[vault] Initial status: ${initialVaultStatus}\n`)

  const fastify = await createApp({
    dbPool: { query: async (statement: string) => sql.unsafe(statement) },
    vaultGuardEnabled: true,
  })

  const boss = new BossService(env.DATABASE_URL)
  setOnVaultUnsealed(async () => { await boss.start() })  // AC-29

  fastify.addHook('onReady', async () => {
    if (getVaultStatus() === 'unsealed') await boss.start()  // edge: already unsealed
  })
  fastify.addHook('onClose', async () => {
    await boss.stop()
    await sql.end()
  })

  registerShutdown(fastify)
  await fastify.listen({ port: env.API_PORT, host: '0.0.0.0' })
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`)
  process.exit(1)
})
```

---

### AC-11: Updated `apps/api/src/app.ts`

```typescript
// Additions to AppOptions type in apps/api/src/app.ts
export type AppOptions = {
  dbPool?: DbPool
  logger?: boolean | object
  metricsBindHost?: string
  vaultGuardEnabled?: boolean  // NEW: false in generate-spec.ts dry-run mode
}

// In createApp(), after helmet/cors registration:
if (options.vaultGuardEnabled) {
  await fastify.register(vaultGuardPlugin)
}

// And register vault routes (always — they appear in OpenAPI spec regardless of guard)
await fastify.register(vaultRoutes)
```

---

### AC-12: `packages/crypto` Unit Tests

File: `packages/crypto/src/index.test.ts` — **replace** the existing stub test with:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  encrypt,
  deriveKey,
  HKDF_INFO,
  withSecret,
  SecretValue,
  setVaultKey,
  clearVaultKey,
  isVaultKeySet,
} from './index.js'
import type { EncryptedValue } from './index.js'
import { randomBytes } from 'node:crypto'

describe('AES-256-GCM encrypt/decrypt (via withSecret)', () => {
  let testKey: Buffer

  beforeEach(() => {
    testKey = randomBytes(32)
    setVaultKey(testKey)
  })

  afterEach(() => {
    clearVaultKey()
  })

  it('round-trips plaintext through encrypt → withSecret', async () => {
    const plaintext = Buffer.from('super-secret-value-42', 'utf8')
    const encrypted = await encrypt(plaintext, testKey)
    const result = await withSecret(encrypted, async (buf) => buf.toString('utf8'))
    expect(result).toBe('super-secret-value-42')
  })

  it('produces versioned ciphertext format', async () => {
    const encrypted = await encrypt(Buffer.from('test', 'utf8'), testKey)
    expect(encrypted.version).toBe(1)
    expect(typeof encrypted.iv).toBe('string')
    expect(typeof encrypted.ciphertext).toBe('string')
    expect(typeof encrypted.tag).toBe('string')
    // IV = 12 bytes = 24 hex chars
    expect(encrypted.iv.length).toBe(24)
    // Tag = 16 bytes = 32 hex chars
    expect(encrypted.tag.length).toBe(32)
  })

  it('produces a different IV on every call (probabilistic)', async () => {
    const pt = Buffer.from('test', 'utf8')
    const enc1 = await encrypt(pt, testKey)
    const enc2 = await encrypt(pt, testKey)
    expect(enc1.iv).not.toBe(enc2.iv)
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext)
  })

  it('throws on wrong key (GCM auth tag mismatch)', async () => {
    const encrypted = await encrypt(Buffer.from('secret', 'utf8'), testKey)
    const wrongKey = randomBytes(32)
    setVaultKey(wrongKey)
    await expect(withSecret(encrypted, async (b) => b)).rejects.toThrow(/Decryption failed/)
  })

  it('throws if vault is sealed (no key set)', async () => {
    clearVaultKey()
    const encrypted = await encrypt(Buffer.from('secret', 'utf8'), testKey)
    await expect(withSecret(encrypted, async (b) => b)).rejects.toThrow(/vault is sealed/)
  })

  it('zeros the plaintext Buffer after withSecret callback returns', async () => {
    const encrypted = await encrypt(Buffer.from('zero-me', 'utf8'), testKey)
    let capturedBuf: Buffer | null = null
    await withSecret(encrypted, async (buf) => {
      capturedBuf = buf
    })
    // After withSecret returns, the buffer should be zeroed
    expect(capturedBuf!.every((b) => b === 0)).toBe(true)
  })

  it('zeros the plaintext Buffer even if callback throws', async () => {
    const encrypted = await encrypt(Buffer.from('zero-on-error', 'utf8'), testKey)
    let capturedBuf: Buffer | null = null
    await expect(
      withSecret(encrypted, async (buf) => {
        capturedBuf = buf
        throw new Error('callback error')
      })
    ).rejects.toThrow('callback error')
    expect(capturedBuf!.every((b) => b === 0)).toBe(true)
  })
})

describe('HKDF-SHA256 key derivation', () => {
  it('produces 32-byte keys', () => {
    const ikm = randomBytes(32)
    const key = deriveKey(ikm, HKDF_INFO.PRIMARY)
    expect(key.length).toBe(32)
  })

  it('is deterministic: same IKM + info = same key', () => {
    const ikm = randomBytes(32)
    const key1 = deriveKey(ikm, HKDF_INFO.PRIMARY)
    const key2 = deriveKey(ikm, HKDF_INFO.PRIMARY)
    expect(key1.equals(key2)).toBe(true)
  })

  it('produces distinct keys for different info strings', () => {
    const ikm = randomBytes(32)
    const primary = deriveKey(ikm, HKDF_INFO.PRIMARY)
    const audit = deriveKey(ikm, HKDF_INFO.AUDIT_LOG)
    expect(primary.equals(audit)).toBe(false)
  })

  it('produces distinct keys for different IKM', () => {
    const ikm1 = randomBytes(32)
    const ikm2 = randomBytes(32)
    const key1 = deriveKey(ikm1, HKDF_INFO.PRIMARY)
    const key2 = deriveKey(ikm2, HKDF_INFO.PRIMARY)
    expect(key1.equals(key2)).toBe(false)
  })
})

describe('SecretValue wrapper', () => {
  it('redacts in toString', () => {
    expect(new SecretValue('secret').toString()).toBe('[REDACTED]')
  })

  it('redacts in JSON.stringify', () => {
    const obj = { s: new SecretValue('secret') }
    expect(JSON.stringify(obj)).toBe('{"s":"[REDACTED]"}')
  })

  it('exposes value through use()', () => {
    expect(new SecretValue('hello').use((v) => v.toUpperCase())).toBe('HELLO')
  })
})

describe('setVaultKey / clearVaultKey / isVaultKeySet', () => {
  afterEach(() => { clearVaultKey() })

  it('reports key presence correctly', () => {
    clearVaultKey()
    expect(isVaultKeySet()).toBe(false)
    setVaultKey(randomBytes(32))
    expect(isVaultKeySet()).toBe(true)
    clearVaultKey()
    expect(isVaultKeySet()).toBe(false)
  })
})
```

---

### AC-13: Integration Test — Full Vault Lifecycle

File: `apps/api/src/__tests__/vault-lifecycle.test.ts`

**Primary test path: passphrase mode** (product decision — no filesystem setup required).

Uses `describe.sequential` + `beforeEach(resetVaultForTest())` per AC-20.

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createApp } from '../app.js'
import { resetVaultForTest } from './helpers/vault-test-cleanup.js'

const TEST_PASSPHRASE = 'test-passphrase-12chars'

describe.sequential('Vault lifecycle (passphrase mode)', () => {
  beforeEach(async () => {
    process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'  // test bootstrap bypass — prod uses token
    await resetVaultForTest()
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('returns 503 on protected routes before initialization', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/api/v1/some-future-route' })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('GET /health and GET /health/ return 200 while sealed', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/health/' })).statusCode).toBe(200)  // trailing slash
    await app.close()
  })

  it('POST /vault/init with passphrase succeeds', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/init',
      payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      initialized: true,
      keyVersion: 1,
      kmsType: 'passphrase',
    })
    await app.close()
  })

  it('POST /vault/init a second time returns 409', async () => {
    // vault_state row persists from previous test (sequential order)
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/init',
      payload: { kmsType: 'passphrase', passphrase: TEST_PASSPHRASE },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'already_initialized' })
    await app.close()
  })

  it('POST /vault/unseal with correct passphrase succeeds', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })  // new instance = sealed
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      payload: { passphrase: TEST_PASSPHRASE },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ unsealed: true, kmsType: 'passphrase' })
    await app.close()
  })

  it('POST /vault/unseal with wrong passphrase returns 401', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      payload: { passphrase: 'wrong-passphrase-here' },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'unseal_failed' })
    await app.close()
  })

  it('after unseal, protected routes are not 503', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    await app.inject({
      method: 'POST', url: '/api/v1/vault/unseal',
      payload: { passphrase: TEST_PASSPHRASE },
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/some-future-route' })
    expect(res.statusCode).not.toBe(503)
    await app.close()
  })
})
```

**Additional test file (optional):** `vault-envelope.test.ts` — sets `VAULT_ENVELOPE_KEY_HALF` + tmpDir file half; tests envelope init/unseal smoke path.

---

### AC-14: `env.ts` — `VAULT_KEY_DIR` (Superuser Guard Already Done)

**Given** Story 1.4 already implemented the `DATABASE_URL` superuser guard in `apps/api/src/config/env.ts` (lines 6–15) with tests in `apps/api/src/config/env.test.ts`,
**When** Story 1.5 is complete,
**Then** only `VAULT_KEY_DIR` is added — do **not** duplicate or modify the existing `DATABASE_URL` refine logic.

```typescript
// Additions to apps/api/src/config/env.ts envSchema ONLY:

// VAULT_KEY_DIR: directory for envelope/file key halves (read-only mount in production).
VAULT_KEY_DIR: z.string().min(1).default('/run/secrets'),

// Envelope mode only: 32 lowercase hex chars = 16-byte env half. Optional at startup.
VAULT_ENVELOPE_KEY_HALF: z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'VAULT_ENVELOPE_KEY_HALF must be 32 lowercase hex characters')
  .optional(),

// First-init protection (AC-23). Generate: openssl rand -base64 32
VAULT_BOOTSTRAP_TOKEN: z.string().min(32).optional(),

// Dev-only: allow init without bootstrap token. NEVER true in production.
VAULT_ALLOW_REMOTE_INIT: z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true'),
```

**Production envelope env half:** Prefer mounting env half as a **file** at `/run/secrets/envelope-env-half` (single line, 32 hex chars) instead of plain `VAULT_ENVELOPE_KEY_HALF` env var — readable via `docker exec` / `/proc/self/environ`. Story 1.5 reads env var OR file:

```typescript
// env.ts loader — if VAULT_ENVELOPE_KEY_HALF unset, try readFileSync('/run/secrets/envelope-env-half')
VAULT_ENVELOPE_KEY_HALF_FILE: z.string().default('/run/secrets/envelope-env-half'),
```

**And** `.env.example` documents:

```bash
VAULT_KEY_DIR=/run/secrets
# Envelope mode only (16 bytes as 32 hex chars). Generate: openssl rand -hex 16
# VAULT_ENVELOPE_KEY_HALF=abc123...
```

**And** `apps/api/src/config/env.test.ts` gains a test that `VAULT_KEY_DIR` defaults to `'/run/secrets'` when unset.

**Verification:** `pnpm --filter @project-vault/api test -- env.test.ts` — existing superuser guard tests must still pass unchanged.

---

### AC-15: Global `AppError` Handler for Vault Routes

**Given** `AppError` exists at `apps/api/src/lib/errors.ts` but no Fastify error handler is registered yet,
**When** vault routes throw `AppError('UNSEAL_FAILED', '...', 401)`,
**Then** the client receives the correct HTTP status and JSON body — not a generic 500.

```typescript
// apps/api/src/app.ts — register BEFORE route registration
import { AppError } from './lib/errors.js'

fastify.setErrorHandler((error, _req, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.code.toLowerCase(), // e.g. 'unseal_failed' — match epics snake_case convention
      message: error.message,
    })
  }
  // Preserve Fastify/Zod validation errors (statusCode already set)
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return reply.status(error.statusCode).send({
      error: 'validation_error',
      message: error.message,
    })
  }
  fastify.log.error(error)
  return reply.status(500).send({ error: 'internal_error', message: 'An unexpected error occurred' })
})
```

**Error code mapping (canonical — use these exact `AppError` codes):**

| Scenario | HTTP | `error` field in body | `AppError.code` |
|---|---|---|---|
| Passphrase < 12 chars | 400 | `invalid_passphrase` | `INVALID_PASSPHRASE` |
| Envelope ack missing | 400 | `acknowledgment_required` | `ACKNOWLEDGMENT_REQUIRED` |
| File mode ack missing | 400 | `acknowledgment_required` | `ACKNOWLEDGMENT_REQUIRED` |
| Key file unreadable / outside `VAULT_KEY_DIR` | 400 | `key_file_not_found` | `KEY_FILE_NOT_FOUND` |
| Key/envelope file wrong size | 400 | `invalid_key_file` | `INVALID_KEY_FILE` |
| `VAULT_ENVELOPE_KEY_HALF` missing (envelope unseal) | 503 | `envelope_env_half_missing` | `ENVELOPE_ENV_HALF_MISSING` |
| Vault already initialized | 409 | `already_initialized` | `ALREADY_INITIALIZED` |
| Vault already unsealed | 400 | `already_unsealed` | `ALREADY_UNSEALED` |
| Unseal before init | 400 | `not_initialized` | `NOT_INITIALIZED` |
| Wrong credentials at unseal | 401 | `unseal_failed` | `UNSEAL_FAILED` |
| Bootstrap token missing/wrong on init | 403 | `bootstrap_forbidden` | `BOOTSTRAP_FORBIDDEN` |
| Unseal rate limit exceeded | 429 | `rate_limited` | (rate-limit plugin) |
| Corrupt/tampered vault_state | 503 | `vault_corrupted` | `VAULT_CORRUPTED` |

**Canonical API error format (product decision):** lowercase snake_case in JSON `error` field; `AppError.code` remains SCREAMING_SNAKE internally.

**Example responses:**

```json
// POST /api/v1/vault/unseal with wrong key file
HTTP/1.1 401 Unauthorized
{ "error": "unseal_failed", "message": "Vault unseal failed: key file does not match stored vault configuration." }

// POST /api/v1/vault/init when vault_state row already exists
HTTP/1.1 409 Conflict
{ "error": "already_initialized", "message": "Vault is already initialized. Use POST /api/v1/vault/unseal to unseal." }

// POST /api/v1/vault/init with path outside VAULT_KEY_DIR
HTTP/1.1 400 Bad Request
{ "error": "key_file_not_found", "message": "Cannot read key file at path: <redacted>" }
```

**And** a unit test in `apps/api/src/__tests__/vault-errors.test.ts` injects each error path via `app.inject()` and asserts status + body shape (no integration DB required for validation/Zod cases).

---

### AC-16: Docker Compose Master Key Volume Wiring

**Given** `docker-compose.prod.yml` declares a `vault_keys` volume reserved for Story 1.5 (line 38),
**When** Story 1.5 is complete,
**Then** both dev and prod compose files mount the key directory read-only into the API container.

**`docker-compose.yml` (dev) — add to `api` service:**

```yaml
  api:
    volumes:
      - ./dev-secrets:/run/secrets:ro   # envelope-half.bin and/or vault-key.bin (file mode)
    environment:
      VAULT_KEY_DIR: /run/secrets
      # Envelope mode: set in .env (not committed). Generate: openssl rand -hex 16
      VAULT_ENVELOPE_KEY_HALF: ${VAULT_ENVELOPE_KEY_HALF:-}
```

**Operator comment block:**

```yaml
# Passphrase init (dev):
#   curl -X POST .../vault/init -d '{"kmsType":"passphrase","passphrase":"your-12-char-min"}'
# Envelope init (prod recommended):
#   openssl rand -hex 16  → VAULT_ENVELOPE_KEY_HALF
#   openssl rand -out dev-secrets/envelope-half.bin 16
#   curl -X POST .../vault/init -d '{"kmsType":"envelope","envelopeKeyPath":"/run/secrets/envelope-half.bin","acknowledgeSplitKeyModel":true}'
```

**And** the API container healthcheck (`curl /health`) continues to pass while sealed — only `/ready` reflects vault state (see AC-8).

**`docker-compose.prod.yml` — add to `api` service:**

```yaml
  api:
    volumes:
      - vault_keys:/run/secrets:ro
    environment:
      VAULT_KEY_DIR: /run/secrets
      VAULT_ENVELOPE_KEY_HALF: ${VAULT_ENVELOPE_KEY_HALF:?VAULT_ENVELOPE_KEY_HALF required for envelope mode}
```

**And** add `dev-secrets/` to `.gitignore`.

---

### AC-17: Sealed-State Behavior for All Non-Allowlisted Endpoints

**Given** the vault is `uninitialized` or `sealed`,
**When** a client calls any endpoint not in the vault guard allowlist,
**Then** the response is always `503` with the same body regardless of HTTP method or path depth.

**Examples (all must return identical 503 body while sealed):**

```bash
# Future auth route (Story 1.6) — blocked now
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3000/api/v1/auth/register
# → 503

# Metrics — blocked (not in allowlist)
curl -s http://localhost:3000/metrics
# → 503 { "status": "sealed", "message": "Vault not initialized" }

# OpenAPI spec route (if registered) — blocked
curl -s http://localhost:3000/documentation
# → 503

# Trailing slash variant — normalized to /health (product decision: ALLOW)
curl -s http://localhost:3000/health/
# → 200
```

**And** query strings on allowlisted routes must not break matching:

```bash
curl -s 'http://localhost:3000/health?verbose=1'
# → 200 (query stripped by vault guard: req.url.split('?')[0])
```

**And** an integration test asserts `/metrics` returns 503 while sealed and 200 (or Prometheus output) after unseal.

---

### AC-18: Operator Ceremony — End-to-End curl Sequences

#### Sequence A — Passphrase mode (dev / small teams)

```bash
# Step 1: Init with passphrase
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"passphrase","passphrase":"correct-horse-battery-staple"}' | jq .
# → { "initialized": true, "keyVersion": 1, "kmsType": "passphrase" }

# Step 2: Restart API (simulates crash — vault seals)
docker compose restart api && sleep 5

# Step 3: Unseal with same passphrase
curl -s -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' \
  -d '{"passphrase":"correct-horse-battery-staple"}' | jq .
# → { "unsealed": true, "keyVersion": 1, "kmsType": "passphrase" }

# Step 4: Wrong passphrase → 401 (no oracle — same error as wrong file key)
curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' \
  -d '{"passphrase":"wrong-passphrase-here"}'
# → { "error": "unseal_failed", ... } HTTP 401
```

#### Sequence B — Envelope mode (production recommended)

```bash
# Step 0: Generate halves
export VAULT_ENVELOPE_KEY_HALF=$(openssl rand -hex 16)
mkdir -p dev-secrets
openssl rand -out dev-secrets/envelope-half.bin 16

# Step 1: Init (env half must be set in API container env)
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"envelope","envelopeKeyPath":"/run/secrets/envelope-half.bin","acknowledgeSplitKeyModel":true}' | jq .

# Step 2: After restart, unseal (env half from process env + file half from request)
curl -s -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' \
  -d '{"envelopeKeyPath":"/run/secrets/envelope-half.bin"}' | jq .
```

#### Sequence C — File mode (downgraded — requires ack)

```bash
openssl rand -out dev-secrets/vault-key.bin 32
curl -s -X POST http://localhost:3000/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"file","masterKeyPath":"/run/secrets/vault-key.bin","acknowledgeCoLocationRisk":true}' | jq .
```

**Common steps (all modes):**

```bash
# Liveness always works (including trailing slash — product decision)
curl -s http://localhost:3000/health/ | jq .
# → { "status": "ok", "version": "..." }

# Readiness reflects vault state
curl -s http://localhost:3000/ready | jq .
# → 503 while sealed/uninitialized; 200 after init+unseal and DB reachable
```

**And** integration tests in AC-13 cover **passphrase mode** as the primary automated path; envelope and file modes have dedicated unit tests for IKM derivation + at least one integration smoke test each.

---

### AC-19: `loadInitialVaultState()` Uses `getDb()` Singleton

**Given** `packages/db/src/index.ts` exports `getDb()` as a Drizzle singleton,
**When** `loadInitialVaultState()` runs at startup,
**Then** it uses `getDb()` — not a separate postgres connection — so vault state queries share the same pool as all other DB operations.

```typescript
// apps/api/src/modules/vault/key-service.ts
import { getDb } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'  // confirm export path matches Story 1.4 schema layout

export async function loadInitialVaultState(): Promise<VaultStatus> {
  const db = getDb()
  const rows = await db.select().from(vaultState).limit(1)
  _status = rows.length === 0 ? 'uninitialized' : 'sealed'
  return _status
}
```

**And** `main.ts` calls `loadInitialVaultState()` **after** `DATABASE_URL` is set in the environment but **before** `createApp()` — the DB singleton lazily connects on first `getDb()` call.

**And** integration tests that truncate `vault_state` between cases use `withAdminAccess` or a direct `getDb()` delete — never the postgres superuser (CI uses `vault_app`).

---

### AC-20: Integration Test DB Isolation (Recommended Strategy)

**Product decision:** Truncating `vault_state` in a shared CI database is acceptable **when scoped correctly**. The recommended approach below is better than a one-time `beforeAll` truncate alone.

#### Recommended pattern (implement this)

1. **Dedicated test file only:** `vault-lifecycle.test.ts` — no other test file touches `vault_state`.
2. **Sequential execution:** Use Vitest `describe.sequential` so init → 409 → unseal → wrong-key tests run in order without parallel interference.
3. **`beforeEach` reset (not just `beforeAll`):** Call `resetVaultForTest()` before every test — handles ordering flakiness if tests are re-run individually.
4. **In-memory + DB reset together:** `zeroKeys()` clears process-level key buffers; `DELETE FROM vault_state` clears DB — both required because restart simulation creates new app instances within the same process.
5. **CI safety:** GitHub Actions already uses ephemeral Postgres per job — truncating `vault_state` cannot affect production. No separate schema required for v1.

```typescript
// apps/api/src/__tests__/vault-lifecycle.test.ts
describe.sequential('Vault lifecycle', () => {
  beforeEach(async () => {
    await resetVaultForTest()
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  // Primary path: passphrase mode (product decision)
  it('init → sealed → unseal with passphrase', async () => { /* ... */ })
  it('double init returns 409', async () => { /* depends on prior init in same describe */ })
  // ...
})
```

```typescript
// apps/api/src/__tests__/helpers/vault-test-cleanup.ts
export async function resetVaultForTest(): Promise<void> {
  const { zeroKeys, loadInitialVaultState } = await import('../modules/vault/key-service.js')
  zeroKeys()
  await getDb().delete(vaultState)
  await loadInitialVaultState()  // AC-26: sync _status — empty DB → 'uninitialized'
}
```

#### Why NOT separate schema or template DB (deferred)

| Approach | Verdict |
|---|---|
| `beforeEach` DELETE on `vault_state` + `describe.sequential` | **Recommended for v1** — simple, fast, CI-safe |
| Postgres template DB clone per file | Overkill for single-row platform table |
| Transaction rollback | **Does not work** — in-memory `_status` / `_activeKey` cannot roll back with PG transaction |
| Global truncate in shared `setup.ts` | **Avoid** — breaks parallel test workers in other files |

#### Vitest config (optional hardening)

Add to `apps/api/vitest.config.ts` or use file-level directive if flakiness persists:

```typescript
// Run vault lifecycle tests in isolation from other api tests
test: {
  poolOptions: { forks: { singleFork: true } },  // only if needed after describe.sequential
}
```

**And** integration tests use **passphrase mode** as the default fixture (`"test-passphrase-12chars"`) — no filesystem key files required for the primary test path.

---

### AC-21: OpenAPI Spec Includes Vault Endpoints

**Given** `apps/api/src/scripts/generate-spec.ts` currently writes a stub empty `paths: {}` object,
**When** vault routes are registered in `createApp()` (always, regardless of `vaultGuardEnabled`),
**Then** a follow-up task wires `generate-spec.ts` to boot `createApp({ logger: false })` and dump real paths — **OR** if that is out of scope for this story, manually verify vault route Zod schemas are registered so a future spec generator picks them up.

**Minimum for Story 1.5:** vault route handlers include Fastify `schema: { body, response, tags }` blocks (AC-6) so when spec generation is wired (Story 1.11 or earlier), `POST /api/v1/vault/init` and `POST /api/v1/vault/unseal` appear under tag `vault`.

**Verification command (after spec generator wired):**

```bash
pnpm --filter @project-vault/api generate-spec
jq '.paths["/api/v1/vault/init"]' packages/shared/openapi.json
# → non-null post operation
```

---

### AC-22: `no-bare-decrypt` ESLint Rule — Implement Real Logic

**Given** `packages/eslint-config/rules/no-bare-decrypt.js` is currently a **stub that passes all files** (Story 1.1),
**When** Story 1.5 exports `bootstrapDecrypt`,
**Then** the rule must be upgraded from stub to real enforcement **in this story** — do not defer to Story 1.11.

```javascript
// packages/eslint-config/rules/no-bare-decrypt.js — replace stub create() with:
create(context) {
  const blockedNames = context.options[0]?.blockedNames ?? ['decrypt', 'bootstrapDecrypt']
  const allowNames = new Set(context.options[0]?.allowNames ?? [])
  return {
    CallExpression(node) {
      if (node.callee.type !== 'Identifier') return
      const name = node.callee.name
      if (!blockedNames.includes(name) || allowNames.has(name)) return
      context.report({ node, message: `Bare ${name}() call forbidden — use withSecret()` })
    },
    ImportSpecifier(node) {
      const name = node.imported.name
      if (blockedNames.includes(name) && !allowNames.has(name)) {
        context.report({ node, message: `Import of ${name} forbidden outside bootstrap callers` })
      }
    },
  }
}
```

**And** update `packages/eslint-config/index.js` with the two-tier config from Dev Notes (block everywhere in `apps/api/src/**`, allow `bootstrapDecrypt` only in `key-service.ts`).

**And** add a lint test fixture or run `pnpm lint` to confirm importing `{ decrypt }` in a random API module fails CI.

---

### AC-23: Bootstrap Protection Against Init Squatting

**Red Team finding:** An attacker who reaches `POST /api/v1/vault/init` on a fresh deploy before the operator can initialize the vault with **their** credentials and lock out the legitimate operator. The 409 on second init does not help — first init wins.

**Given** the vault is uninitialized (no `vault_state` row),
**When** `POST /api/v1/vault/init` is called,
**Then** the request is rejected with `403 { error: "bootstrap_forbidden", message: "Vault bootstrap requires valid bootstrap credentials" }` unless **one** of:

| Path | Requirement |
|---|---|
| **(a) Bootstrap token (default for production)** | `VAULT_BOOTSTRAP_TOKEN` env var is set (≥32 random bytes, base64url) **AND** request header `X-Vault-Bootstrap-Token` matches via `timingSafeEqual` |
| **(b) Dev downgrade** | `VAULT_ALLOW_REMOTE_INIT=true` is explicitly set (document as **dev-only** in `.env.example`) |

**And** after successful init, bootstrap token is **not** required for unseal — only for first init while `vault_state` is empty.

**And** if bootstrap token is configured but header is missing/wrong → `403 bootstrap_forbidden` (same message — no oracle whether token exists).

**Env schema additions:**

```typescript
VAULT_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
VAULT_ALLOW_REMOTE_INIT: z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true'),
```

**Implementation in `initVault()` — first line when `_status === 'uninitialized'`:**

```typescript
function assertBootstrapAuthorized(req: { headers: Record<string, string | string[] | undefined> }): void {
  if (env.VAULT_ALLOW_REMOTE_INIT) return
  const token = env.VAULT_BOOTSTRAP_TOKEN
  if (!token) {
    throw new AppError('BOOTSTRAP_FORBIDDEN', 'Vault bootstrap requires valid bootstrap credentials', 403)
  }
  const header = req.headers['x-vault-bootstrap-token']
  const supplied = Array.isArray(header) ? header[0] : header
  if (!supplied || supplied.length !== token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
    throw new AppError('BOOTSTRAP_FORBIDDEN', 'Vault bootstrap requires valid bootstrap credentials', 403)
  }
}
```

**Generate token:** `openssl rand -base64 32` — set once at deploy, discard after init (or rotate in secrets manager).

**Integration tests:** Set `VAULT_ALLOW_REMOTE_INIT=true` in test env OR pass valid `X-Vault-Bootstrap-Token` header.

---

### AC-24: Unseal Rate Limiting

**Red Team finding:** Unlimited unseal attempts enable offline-speed passphrase guessing against weak passphrases despite Argon2id cost.

**Given** repeated requests to `POST /api/v1/vault/unseal`,
**When** the rate exceeds **5 requests per minute per source IP**,
**Then** return `429 { error: "rate_limited", message: "Too many unseal attempts", retryAfter: <seconds> }`.

**Implementation:**

```typescript
// apps/api/src/modules/vault/routes.ts — register ONLY on unseal route
import rateLimit from '@fastify/rate-limit'

await fastify.register(rateLimit, {
  max: 5,
  timeWindow: '1 minute',
  hook: 'preHandler',
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: (_req, context) => ({
    error: 'rate_limited',
    message: 'Too many unseal attempts',
    retryAfter: Math.ceil(context.ttl / 1000),
  }),
})
```

**Critical — no timing oracle:** For passphrase mode, **always run full Argon2id derivation** before returning 401, even when rate limit will apply on the *next* request. Do not short-circuit failed unseal before KDF completes.

**And** init route is NOT rate-limited the same way (bootstrap token is the control) — but MAY add a separate 10/min limit to prevent DoS via expensive Argon2id init spam.

---

### AC-25: Request Body Log Redaction

**Red Team finding:** Passphrase in JSON body may leak via pino request logging, APM, or misconfigured reverse proxies.

**Given** any request to vault routes,
**When** the request body contains `passphrase`,
**Then** structured logs, error handlers, and serializers **never** emit the passphrase value.

**Implementation:**

```typescript
// apps/api/src/plugins/redact-secrets.ts
const REDACTED_FIELDS = new Set(['passphrase'])

export function redactBodyForLog(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const copy = { ...(body as Record<string, unknown>) }
  for (const key of REDACTED_FIELDS) {
    if (key in copy) copy[key] = '[REDACTED]'
  }
  return copy
}

// In vault route handlers — NEVER log req.body directly:
req.log.info({ event: 'vault.init', kmsType: body.kmsType, body: redactBodyForLog(req.body) })
```

**And** Fastify serializer hook redacts `passphrase` from any logged request object.

**And** test `apps/api/src/__tests__/vault-log-redaction.test.ts`:
- Init with known passphrase
- Capture log output (pino destination stream or inject mock logger)
- Assert log strings do **not** contain the test passphrase

**And** extend redaction to `masterKeyPath` and `envelopeKeyPath` in logs (paths redacted to `[REDACTED]` — already policy, now tested).

---

### AC-26: State Sync After Test Reset and DB Truncate

**FMEA finding:** `zeroKeys()` sets `_status = 'sealed'`. After `DELETE FROM vault_state`, module state says "sealed" but DB says "no row" — `/ready` returns wrong message ("manual unseal" vs "not initialized") and tests become flaky.

**Given** integration tests call `resetVaultForTest()`,
**When** the helper completes,
**Then** `_status` reflects the **database**, not a stale in-memory guess:

```typescript
// apps/api/src/__tests__/helpers/vault-test-cleanup.ts
export async function resetVaultForTest(): Promise<void> {
  const { zeroKeys, loadInitialVaultState } = await import('../modules/vault/key-service.js')
  zeroKeys()  // clears keys; temporarily sets _status = 'sealed'
  await getDb().delete(vaultState)
  await loadInitialVaultState()  // RE-SYNC: no row → 'uninitialized'; row exists → 'sealed'
}
```

**And** any production code path that deletes or truncates `vault_state` must call `loadInitialVaultState()` afterward.

---

### AC-27: Startup Fail-Fast When Database Is Unreachable

**FMEA finding:** AC-10 claimed `loadInitialVaultState()` "never throws" — but `getDb().select()` throws if PostgreSQL is down. Starting HTTP with unknown vault state is unsafe.

**Given** the API process starts,
**When** `loadInitialVaultState()` cannot query `vault_state` (connection refused, auth failure, timeout),
**Then** the process **exits with code 1** before `fastify.listen()` — HTTP server must not accept traffic.

```typescript
export async function loadInitialVaultState(): Promise<VaultStatus> {
  try {
    const db = getDb()
    const rows = await db.select().from(vaultState).limit(1)
    _status = rows.length === 0 ? 'uninitialized' : 'sealed'
    warnIfEnvelopeMisconfigured(rows[0])  // AC-29 stderr warning
    return _status
  } catch (err) {
    process.stderr.write(
      '[vault] FATAL: cannot read vault_state — verify DATABASE_URL and that PostgreSQL is reachable.\n'
    )
    throw err  // main().catch → process.exit(1)
  }
}
```

**And** remove any documentation claiming load "never throws" — fail-fast is intentional.

---

### AC-28: Corrupted `vault_state` Handling

**FMEA finding:** Malformed `encrypted_sentinel` JSON or tampered `key_derivation_params` causes uncaught throws → **500 Internal Server Error** with no operator guidance.

**Given** a `vault_state` row exists,
**When** unseal loads state and encounters:
- `JSON.parse(encrypted_sentinel)` failure
- `EncryptedValue` missing required fields or unsupported `version`
- `key_derivation_params` with Argon2 params outside allowed range (see AC-30)

**Then** return `503 { error: "vault_corrupted", message: "vault_state data is corrupt or tampered — restore from backup or re-initialize" }` — **not** 500.

```typescript
function parseVaultStateRow(state: VaultState): { sentinel: EncryptedValue; kdfParams: KeyDerivationParams | null } {
  try {
    const sentinel = JSON.parse(state.encryptedSentinel) as EncryptedValue
    if (!sentinel?.version || !sentinel.iv || !sentinel.ciphertext || !sentinel.tag) {
      throw new Error('invalid EncryptedValue shape')
    }
    let kdfParams: KeyDerivationParams | null = null
    if (state.kmsType === 'passphrase') {
      kdfParams = JSON.parse(state.keyDerivationParams ?? '') as KeyDerivationParams
      validateKeyDerivationParams(kdfParams)  // AC-30
    }
    return { sentinel, kdfParams }
  } catch {
    throw new AppError(
      'VAULT_CORRUPTED',
      'vault_state data is corrupt or tampered — restore from backup or re-initialize',
      503
    )
  }
}
```

**And** structured log: `{ event: 'vault.unseal.failed', error: 'vault_corrupted' }` — no sentinel bytes in log.

---

### AC-29: Defer `pg-boss` Start Until Vault Is Unsealed

**FMEA finding:** `BossService.start()` runs in unconditional `onReady` hook. Future workers (Story 1.11+) calling `withSecret()` would throw while vault is sealed. HTTP vault guard does not protect background jobs.

**Given** the API starts with vault `sealed` or `uninitialized`,
**When** Fastify fires `onReady`,
**Then** `boss.start()` is **NOT** called.

**Given** vault transitions to `unsealed` (via init or unseal),
**When** transition completes successfully,
**Then** `boss.start()` is called exactly once (idempotent).

```typescript
// apps/api/src/main.ts
const boss = new BossService(env.DATABASE_URL)

setOnVaultUnsealed(async () => {
  await boss.start()
})

fastify.addHook('onReady', async () => {
  // Restart case: already unsealed (e.g. dev hot-reload edge) — start immediately
  if (getVaultStatus() === 'unsealed') await boss.start()
})

fastify.addHook('onClose', async () => {
  await boss.stop()
  await sql.end()
})
```

```typescript
// key-service.ts — call after successful initVault() and unsealVault()
let _onUnsealed: (() => Promise<void>) | null = null
export function setOnVaultUnsealed(fn: () => Promise<void>): void { _onUnsealed = fn }

async function notifyUnsealed(): Promise<void> {
  await _onUnsealed?.()
}
```

**And** on sealed startup with `kms_type === 'envelope'` but missing `VAULT_ENVELOPE_KEY_HALF` (and no file fallback), write stderr warning:

```
[vault] WARN: vault is sealed (envelope mode) but VAULT_ENVELOPE_KEY_HALF is not configured — unseal will fail until set
```

---

### AC-30: Argon2 Native Dependency and Parameter Validation

**FMEA finding:** `argon2` npm package requires native bindings — Docker/CI build fails silently until first passphrase operation. Tampered low-cost Argon2 params in DB enable fast offline cracking.

**Docker / CI requirement:**

```dockerfile
# apps/api/Dockerfile builder stage — argon2 native compile deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
```

**And** CI must run `pnpm --filter @project-vault/crypto test` (loads argon2) before merge.

**Parameter validation** (`packages/crypto/src/passwords.ts`):

```typescript
const ALLOWED_ARGON2 = { memoryCost: 65536, timeCost: 3, parallelism: 4 } as const

export function validateKeyDerivationParams(params: KeyDerivationParams): void {
  if (params.type !== 'argon2id') throw new Error('unsupported KDF type')
  if (params.memoryCost < ALLOWED_ARGON2.memoryCost) throw new Error('memoryCost below minimum')
  if (params.timeCost < ALLOWED_ARGON2.timeCost) throw new Error('timeCost below minimum')
  if (params.parallelism < 1 || params.parallelism > 4) throw new Error('parallelism out of range')
  if (!/^[0-9a-f]{32}$/.test(params.salt)) throw new Error('invalid salt')
}
```

**And** reject params strictly **below** canonical minimums (allows future increases, blocks tampering downward).

**Event loop note (accepted v1 risk):** Argon2id ~1s blocks the Node event loop during init/unseal. Document in Dev Notes; `worker_threads` wrapper deferred to Story 1.11+.

---

## Tasks / Subtasks

- [x] **Task 1: Implement `packages/crypto` core primitives** (AC: 1a–1h)
  - [x] Create `packages/crypto/src/types.ts`, `aes.ts`, `kdf.ts`, `secret-value.ts`
  - [x] Create `packages/crypto/src/passwords.ts` — Argon2id IKM derivation (AC-1f); add `argon2` npm dependency
  - [x] Create `packages/crypto/src/envelope.ts` — split-key combination (AC-1g)
  - [x] Update `packages/crypto/src/index.ts` — export all public APIs including `deriveIkmFromPassphrase`, `combineEnvelopeHalves`
  - [x] Unit tests for passphrase KDF, envelope combine, AES round-trip

- [x] **Task 2: `vault_state` Drizzle schema + migration** (AC: 2a–2b)
  - [x] Create `packages/db/src/schema/vault-state.ts` — single-row table with CHECK constraint
  - [x] Add `export * from './vault-state.js'` to `packages/db/src/schema/index.ts`
  - [x] Create `packages/db/src/migrations/0003_vault_state.sql` — DDL with CHECK constraints and COMMENT (numbered 0003, not 0002: `0002_audit_log_revoke.sql` already existed on this branch)
  - [x] Add `vault_state` to `check-rls-coverage.ts` allow-list
  - [x] Run `pnpm --filter @project-vault/db db:migrate` (on fresh test DB) — verify no errors

- [x] **Task 3: Key service module** (AC: 3, 4, 7)
  - [x] Implement `deriveIkm()` dispatcher for three custody models: passphrase, envelope, file
  - [x] Store `key_derivation_params` JSON for passphrase mode only
  - [x] Unseal reads stored `kms_type` and validates matching credential field
  - [x] Confirm: `readKeyMaterialFile()` uses `lstatSync` (no symlink follow) + `O_NOFOLLOW` open + regular-file check
  - [x] Confirm: `initVault()` uses `INSERT ... ON CONFLICT DO NOTHING` + `.returning()` to atomically guard against TOCTOU race
  - [x] Confirm: `getAuditKey()` returns `Buffer.from(_auditKey)` — a copy, not the module-level reference
  - [x] Confirm: `unsealVault()` uses `bootstrapDecrypt` (static import) — not dynamic `import('@project-vault/crypto/internal/aes')`
  - [x] Confirm: raw `keyMaterial` Buffer is zeroed immediately after both keys are derived in both `initVault()` and `unsealVault()`
  - [x] Confirm: `primaryKey` buffer is zeroed after `setVaultKey()` call (which takes its own copy)

- [x] **Task 4: Vault routes** (AC: 6)
  - [x] Create `apps/api/src/modules/vault/schema.ts` — Zod schemas for init/unseal request+response
  - [x] Create `apps/api/src/modules/vault/routes.ts` — `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`
  - [x] Confirm: both route handlers emit structured `req.log.info/warn` on success and failure with `event` field; `masterKeyPath` is NEVER logged
  - [x] Add `vaultRoutes` to allow-list in `apps/api/src/__tests__/route-audit.test.ts` (route-audit.test.ts is still a Story 1.11 `it.todo` stub with no concrete allow-list to extend yet)

- [x] **Task 5: Vault guard plugin** (AC: 5)
  - [x] Create `apps/api/src/plugins/vault-guard.ts` — `onRequest` hook with exact allowlist
  - [x] Confirm: allowlist uses `req.url.split('?')[0]` to strip query params

- [x] **Task 6: Update `apps/api/src/app.ts`** (AC: 11)
  - [x] Add `vaultGuardEnabled?: boolean` to `AppOptions`
  - [x] Register `vaultGuardPlugin` only when `options.vaultGuardEnabled === true`
  - [x] Register `vaultRoutes` always (must appear in OpenAPI spec)
  - [x] Update `scripts/generate-spec.ts` — verify it calls `createApp({ logger: false })` WITHOUT `vaultGuardEnabled: true` (confirmed: generate-spec.ts is still a static-JSON stub independent of createApp(), unchanged)

- [x] **Task 7: Update `GET /ready` health route** (AC: 8)
  - [x] Modify `apps/api/src/routes/health.ts` to import `getVaultStatus` from key-service
  - [x] Three-branch response: `uninitialized` → 503 "not initialized", `sealed` → 503 "manual unseal required", `unsealed` → standard DB check

- [x] **Task 8: Update `apps/api/src/main.ts` startup sequence** (AC: 10)
  - [x] Call `loadInitialVaultState()` after DB connection, before `createApp()`
  - [x] Log initial vault status via `process.stderr.write`
  - [x] Pass `vaultGuardEnabled: true` to `createApp()`

- [x] **Task 9: Update `apps/api/src/lib/shutdown.ts`** (AC: 9)
  - [x] Import `zeroKeys` from `key-service.ts`
  - [x] Call `zeroKeys()` BEFORE `fastify.close()` in SIGTERM/SIGINT handler
  - [x] Call `zeroKeys()` in the catch block too (defensive)

- [x] **Task 10: Add `VAULT_KEY_DIR` and `VAULT_ENVELOPE_KEY_HALF` to `env.ts`** (AC: 14)
  - [x] Add `VAULT_KEY_DIR` env var with default `'/run/secrets'` — do NOT modify existing `DATABASE_URL` superuser guard (already done in Story 1.4)
  - [x] Update `.env.example` with `VAULT_KEY_DIR` documentation
  - [x] Add env test for `VAULT_KEY_DIR` default

- [x] **Task 11: Register global `AppError` handler** (AC: 15)
  - [x] Add `setErrorHandler` in `apps/api/src/app.ts` mapping `AppError.code` → snake_case `error` field
  - [x] Create `apps/api/src/__tests__/vault-errors.test.ts` for validation + error shape assertions

- [x] **Task 12: Docker Compose key volume wiring** (AC: 16)
  - [x] Mount `./dev-secrets:/run/secrets:ro` in `docker-compose.yml` api service
  - [x] Mount `vault_keys:/run/secrets:ro` in `docker-compose.prod.yml` api service
  - [x] Add `dev-secrets/` to `.gitignore`
  - [x] Add operator comment block with openssl + curl init example

- [x] **Task 13: Unit tests for `packages/crypto`** (AC: 12)
  - [x] Replace stub tests in `packages/crypto/src/index.test.ts` with the full test suite from AC-12
  - [x] Run `pnpm --filter @project-vault/crypto test` — all tests pass

- [x] **Task 14: Integration test — vault lifecycle** (AC: 13, 17, 18, 20)
  - [x] Create `apps/api/src/__tests__/vault-lifecycle.test.ts` (consolidated: includes bootstrap-token and custody-model coverage too, per AC-20's "dedicated file only" guidance — no other test file touches `vault_state`)
  - [x] Create `apps/api/src/__tests__/helpers/vault-test-cleanup.ts` with `resetVaultForTest()`
  - [x] Configure test to use real PostgreSQL test DB (`DATABASE_URL` as `vault_app`)
  - [x] All scenarios pass: sealed 503, health always 200, ready 503/unsealed, init success, double init 409, unseal success, wrong key 401, post-unseal routes unblocked, `/metrics` sealed vs unsealed

- [x] **Task 15: Implement real `no-bare-decrypt` ESLint rule** (AC: 22)
  - [x] Replace stub in `packages/eslint-config/rules/no-bare-decrypt.js` with real CallExpression + ImportSpecifier checks
  - [x] Configure two-tier allowlist in `packages/eslint-config/index.js` (block `bootstrapDecrypt` everywhere except `key-service.ts`)

- [x] **Task 17: Red Team hardening** (AC: 23, 24, 25)
  - [x] Implement `assertBootstrapAuthorized()` in init path; add `VAULT_BOOTSTRAP_TOKEN` + `VAULT_ALLOW_REMOTE_INIT` to env.ts
  - [x] Add `@fastify/rate-limit` scoped to `POST /api/v1/vault/unseal` (5 req/min/IP)
  - [x] Replace `readFileSync`/`statSync` with `lstatSync` + `O_NOFOLLOW` in `readKeyMaterialFile()`
  - [x] Add `vault_state` UPDATE/DELETE triggers in `0003_vault_state.sql`
  - [x] Add `redact-secrets.ts` plugin; vault routes use `redactBodyForLog()`; add log redaction test
  - [x] Integration tests: set `VAULT_ALLOW_REMOTE_INIT=true` OR pass `X-Vault-Bootstrap-Token`

- [x] **Task 18: FMEA hardening** (AC: 26, 27, 28, 29, 30)
  - [x] `resetVaultForTest()` calls `loadInitialVaultState()` after DELETE (AC-26)
  - [x] `loadInitialVaultState()` fail-fast on DB error — no HTTP without known state (AC-27)
  - [x] `parseVaultStateRow()` + `503 vault_corrupted` for bad sentinel/params (AC-28)
  - [x] `setOnVaultUnsealed()` + defer `boss.start()` until unsealed (AC-29)
  - [x] `validateKeyDerivationParams()` + Dockerfile native build deps for `argon2` (AC-30)
  - [x] Envelope misconfiguration stderr warning on sealed startup (AC-29)

- [x] **Task 16: Quality gates**
  - [x] `pnpm --filter @project-vault/crypto build` — zero TypeScript errors
  - [x] `pnpm --filter @project-vault/crypto test` — all unit tests pass
  - [x] `pnpm --filter @project-vault/db typecheck` — vault-state schema clean
  - [x] `pnpm --filter @project-vault/api typecheck` — zero TS errors
  - [x] `pnpm --filter @project-vault/api test` — unit + integration tests pass
  - [x] `pnpm lint` — no ESLint errors (especially `no-bare-decrypt` rule)
  - [x] `pnpm build` — monorepo builds successfully
  - [x] `pnpm jscpd` — no duplication threshold exceeded

---

## Dev Notes

### Previous Story Intelligence (Story 1.4 — Database Foundation)

Story 1.4 is in **review** status with substantial implementation already merged. The dev agent MUST build on these patterns — do not reinvent or conflict with them.

**Migration file pattern (critical):**
- `0000_initial_schema.sql` — Drizzle-generated DDL (tables, indexes, FKs). **Never append RLS or manual DDL here** — `drizzle-kit generate` will overwrite it.
- `0001_rls_and_triggers.sql` — manual SQL: `vault_app` role, GRANTs, RLS policies, triggers, `REVOKE DELETE ON api_instances`.
- **Story 1.5 adds `0002_vault_state.sql`** — same manual pattern as `0001`. Do NOT run `drizzle-kit generate` expecting it to produce this file.

**`vault_app` role (already created in 0001):**
- API `DATABASE_URL` must use `vault_app`, never `postgres` — guard already in `env.ts` + `env.test.ts`.
- CI runs migrations as `postgres`, then tests as `vault_app` (see `.github/workflows/ci.yml` lines 79–92).
- `docker-compose.yml` uses a one-shot `migrate` service so `api` never connects as superuser.

**`getDb()` singleton (`packages/db/src/index.ts`):**
- Lazy Drizzle client — first call connects using `process.env.DATABASE_URL`.
- Vault key-service MUST use `getDb()` for all `vault_state` queries — no parallel postgres client.

**`check-rls-coverage.ts` location:**
- Testable core: `packages/db/src/check-rls-coverage.ts`
- CLI wrapper: `scripts/check-rls-coverage.ts`
- Current `EXCLUDED_TABLES`: `new Set(['api_instances'])` — add `'vault_state'` here.

**RLS helpers available:**
- `withOrg(orgId, fn)` — transaction-scoped `set_config('app.current_org_id', ...)`.
- `withAdminAccess(authCtx, fn)` — admin bypass (TODO full auth in 1.11).
- `vault_state` queries bypass all of these — platform-level, no `org_id`.

**Known pitfall from 1.4 review:** `withTestOrg()` cleanup used bare deletes without org context (RLS no-op). Vault tests must use explicit `truncateVaultState()` — do not rely on RLS-scoped deletes for platform tables.

**Schema naming (canonical vs epics):**
- `org_memberships` (not `organization_members`)
- `audit_log_entries` (not `audit_events`)
- Import from `@project-vault/db/schema` — confirm export path matches Story 1.4 layout.

[Source: _bmad-output/implementation-artifacts/1-4-database-foundation-with-postgresql-rls-and-core-schema.md]

---

### Git Intelligence (Recent Commits)

Recent work on this branch establishes patterns Story 1.5 must follow:

| Commit | Relevance |
|---|---|
| `e504a63` Makefile + README | Dev ergonomics — vault init curl examples belong in README operator section |
| `d614f94` Docker deployment improvements | Health endpoints, compose structure — extend with `dev-secrets` mount |
| `52c8117` Docker deployment + health | `/health` liveness vs `/ready` readiness split — vault state layers on `/ready` only |
| Story 1.4 (review) | Full DB schema, RLS, `vault_app`, migrate service, superuser env guard |

**Files that exist and must be extended (not recreated):**
- `apps/api/src/routes/health.ts` — add vault branches to `/ready` only
- `apps/api/src/lib/shutdown.ts` — add `zeroKeys()` before `fastify.close()`
- `apps/api/src/config/env.ts` — add `VAULT_KEY_DIR` only
- `packages/crypto/src/index.ts` — replace stub `withSecret()` with real impl
- `docker-compose.prod.yml` — mount existing `vault_keys` volume

**Files that do NOT exist yet (create fresh):**
- `apps/api/src/modules/vault/*` — entire module
- `apps/api/src/plugins/vault-guard.ts`
- `packages/crypto/src/aes.ts`, `kdf.ts`, `secret-value.ts`, `types.ts`
- `packages/db/src/schema/vault-state.ts`
- `packages/db/src/migrations/0002_vault_state.sql`

---

### Architecture Source References

- Epics AC text: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.5, lines 774–806]
- Encryption architecture: [Source: _bmad-output/planning-artifacts/architecture.md#Authentication & Security, lines 332–340]
- Crypto package structure: [Source: _bmad-output/planning-artifacts/architecture.md#Complete Project Directory Structure, lines 1191–1203]
- Key co-location risk: [Source: _bmad-output/planning-artifacts/architecture.md#Technical Constraints, lines 71–72]
- HKDF_INFO strings: [Source: _bmad-output/planning-artifacts/epics.md, line 800]
- `withSecret()` contract: [Source: _bmad-output/planning-artifacts/architecture.md, lines 339–340]
- `no-bare-decrypt` ESLint rule: [Source: _bmad-output/planning-artifacts/architecture.md, line 875]
- Versioned ciphertext: [Source: _bmad-output/planning-artifacts/architecture.md, line 337]
- Single-row vault_state: [Source: _bmad-output/planning-artifacts/epics.md, line 790]
- Sealed state / manual unseal: [Source: _bmad-output/planning-artifacts/epics.md, lines 792–794]
- Memory zeroing on SIGTERM: [Source: _bmad-output/planning-artifacts/epics.md, line 796]

---

---

### Failure Mode Analysis (FMEA Summary — 2026-06-24)

Reference matrix for operators and dev agents. Mitigations AC-26–30 unless marked *accepted v1*.

| Component | Failure | Effect | Mitigation |
|---|---|---|---|
| `loadInitialVaultState` | DB down at startup | Crash loop | AC-27 fail-fast; fix DB before restart |
| `zeroKeys` + test reset | `_status` desync | Wrong `/ready` message | AC-26 `loadInitialVaultState()` after truncate |
| `encrypted_sentinel` | Corrupt JSON | 500 → ops confusion | AC-28 `503 vault_corrupted` |
| `key_derivation_params` | Tampered low Argon2 cost | Faster brute-force | AC-30 validate on read; UPDATE trigger |
| `argon2` native module | Missing in Docker | Crash on passphrase op | AC-30 builder deps + CI test |
| Argon2id CPU | Event loop blocked ~1s | Request latency spike | *Accepted v1* — rate limit unseal |
| `pg-boss` | Starts while sealed | Future worker crypto errors | AC-29 defer until unsealed |
| SIGKILL | No `zeroKeys()` | Keys in memory until GC | *Accepted v1* — restart seals vault |
| Envelope env half | Missing after restart | Unseal 503 | AC-29 stderr warning at startup |
| Dual postgres pools | `main.ts` + `getDb()` | Connection pressure | *Accepted v1* — consolidate later |

---

### Critical: `no-bare-decrypt` ESLint Rule Scope

The `no-bare-decrypt` ESLint rule (already defined in `packages/eslint-config/rules/no-bare-decrypt.js`) must be configured to:
- **Block** direct `decrypt()` calls in all files under `apps/api/src/**`
- **Block** `bootstrapDecrypt()` calls in ALL files under `apps/api/src/**` EXCEPT `key-service.ts` — any other caller using `bootstrapDecrypt` bypasses the `withSecret()` safety contract just as badly as calling `decrypt()` directly
- **Allow** `decrypt()` in `packages/crypto/src/**` (where it is legitimately implemented)
- **Allow** `bootstrapDecrypt` in `apps/api/src/modules/vault/key-service.ts` only — it is the bootstrap caller that sets up the vault key; it cannot use `withSecret()` because the key isn't set yet at unseal time

Configuration addition in `packages/eslint-config/index.js`:
```javascript
// no-bare-decrypt: block both decrypt and bootstrapDecrypt everywhere in the API
// (bootstrapDecrypt is the re-exported alias; same security constraint applies)
{
  files: ['apps/api/src/**/*.ts'],
  rules: { 'no-bare-decrypt': ['error', { blockedNames: ['decrypt', 'bootstrapDecrypt'] }] }
},
// Exception: vault key-service bootstrap is the sole permitted caller of bootstrapDecrypt
{
  files: ['apps/api/src/modules/vault/key-service.ts'],
  rules: { 'no-bare-decrypt': ['error', { blockedNames: ['decrypt'], allowNames: ['bootstrapDecrypt'] }] }
}
```

**Why `bootstrapDecrypt` must ALSO be blocked:** Exporting `decrypt as bootstrapDecrypt` creates a new name that the original rule doesn't know about. Without explicitly blocking it, any module in `apps/api/src/**` could `import { bootstrapDecrypt }` and call raw decryption, bypassing `withSecret()` and its buffer-zeroing guarantee. The rule must enumerate both names.

---

### Security: `VAULT_KEY_DIR` Path Confinement

`readKeyFile()` resolves the supplied `masterKeyPath` with `path.resolve()` and rejects any path that does not start with `env.VAULT_KEY_DIR`. This prevents arbitrary file read: a crafted path like `../../etc/passwd` resolves to an absolute path outside the allowed directory and receives a generic `KEY_FILE_NOT_FOUND` error (path not echoed in the response — prevents filesystem layout disclosure).

**Production default:** `VAULT_KEY_DIR=/run/secrets` — the conventional Docker secrets / Kubernetes `secretKeyRef` volume mount point.

**Integration tests:** Set `VAULT_ALLOW_REMOTE_INIT=true` in test env **or** pass `X-Vault-Bootstrap-Token` matching `VAULT_BOOTSTRAP_TOKEN`.

**Max file size guard:** `statSync(resolved)` is called before `readFileSync`. Files larger than `MAX_KEY_FILE_BYTES` (4096) are rejected before any read — prevents OOM via `/dev/urandom` or multi-GB files.

---

### Security: Vault Init/Unseal Endpoints — No Application-Layer Auth

`POST /api/v1/vault/init` and `POST /api/v1/vault/unseal` are intentionally excluded from the `SecureRoute` auth middleware (they run before auth is available). This means they have **no application-layer authentication**.

**Required deployment-level mitigation (mandatory for production):**

1. **Bootstrap token (AC-23 — primary control):** Set `VAULT_BOOTSTRAP_TOKEN` and pass `X-Vault-Bootstrap-Token` on first init. Never set `VAULT_ALLOW_REMOTE_INIT=true` in production.
2. **Network isolation (defense in depth):** Firewall init/unseal to internal network / management VLAN even with bootstrap token.
3. **`VAULT_KEY_DIR` confinement + O_NOFOLLOW (AC-7):** Reject symlinks and non-regular files in key directory.
4. **Unseal rate limiting (AC-24):** 5 req/min/IP server-side — do not rely on reverse proxy alone.
5. **Docker Compose / Kubernetes:** Mount key halves as read-only secrets volumes; prefer file mount for envelope env half over process env var.

**Document in operator runbook** that vault endpoints must be network-restricted and bootstrap token required before production deployment.

---



The architecture mandates `withSecret(encrypted, fn)` with exactly **two parameters** (no `key` param). This requires the key to be injected into the package at vault unseal time. The pattern:

```
Vault init/unseal             packages/crypto
─────────────────             ────────────────────
initVault(path)  ─setVaultKey(key)→  _activeKey = copy(key)
                              withSecret(enc, fn):
Any service call                  decrypt(enc, _activeKey)
withSecret(enc, fn) ─────────────→  fn(plaintext) → result
                                  finally: plaintext.fill(0)
```

**Why this is safe:**
- The vault guard (`vaultGuardPlugin`) blocks all routes that could reach `withSecret()` while `_activeKey` is null
- `withSecret()` itself also throws if called while sealed (defense-in-depth)
- `_activeKey` is held by a module-level `Buffer` — the only reference; Node.js GC cannot collect it prematurely

**Why `setVaultKey()` copies the Buffer:**
```typescript
_activeKey = Buffer.from(key)  // own copy
```
The `key` Buffer passed to `setVaultKey()` is owned by the key service, which will zero it after the call. If `packages/crypto` held a reference to the same Buffer, the zero would also zero the active key. By copying, the lifecycle of `_activeKey` is independent.

---

### AES-256-GCM Implementation Details

**IV (Initialization Vector):**
- **12 bytes (96 bits)** — this is the recommended size for GCM; it is processed as-is without hashing
- **Random per encryption** — `randomBytes(12)` — never reuse with the same key
- Larger IVs (>12 bytes) are hashed before use by OpenSSL, reducing randomness guarantees
- **Do NOT use a counter or timestamp as IV** — birthday paradox applies; random is safe at this volume

**Authentication Tag:**
- **16 bytes (128 bits)** — GCM default; maximum security
- OpenSSL's GCM implementation uses constant-time GHASH computation — the `timingSafeEqual` concern is addressed internally by `decipher.final()` throwing on tag mismatch
- **Do not set authTagLength below 16** — shorter tags reduce security against forgery

**Ciphertext encoding:**
- IV, ciphertext, and tag are stored as **lowercase hex strings**
- `JSON.stringify(encryptedValue)` is used to store `EncryptedValue` in `vault_state.encrypted_sentinel`
- Hex chosen over base64 for readability in DB inspection; performance difference is negligible

**Versioning:**
- `version: 1` in every `EncryptedValue`
- `decrypt()` throws immediately on unsupported version — never silently attempt decryption
- Future algorithm migration: bump version, add new branch in `decrypt()`, run re-encryption migration

---

### HKDF-SHA256 Derivation Parameters

```
HKDF(SHA-256, IKM, Salt, Info, L)
  IKM  = raw bytes from key file (≥32 bytes)
  Salt = empty Buffer (RFC 5869 §3.1: "if not provided, HashLen zeros" = valid for uniform IKM)
  Info = context string as UTF-8 bytes (see HKDF_INFO constants in kdf.ts)
  L    = 32 bytes (256-bit AES key)
```

**HKDF_INFO constants (canonical — never hardcode these strings elsewhere):**

| Constant | Info string | Usage |
|---|---|---|
| `HKDF_INFO.PRIMARY` | `'project-vault-v1'` | Primary encryption key (this story) |
| `HKDF_INFO.AUDIT_LOG` | `'project-vault-audit-log-v1'` | Audit log encryption (this story + Story 8.1) |
| `HKDF_INFO.BACKUP` | `'project-vault-backup-v1'` | Backup encryption (Story 9.1) |
| `HKDF_INFO.PLATFORM_AUDIT` | `'project-vault-platform-audit-v1'` | Platform operator audit (Story 9.4) |

**Independent key lifecycles:** The primary key and audit key are derived independently — rotating one (re-running `initVault` with a new key file in a future rotation story) does not require re-encrypting the other's data. Per-entry `key_version` and `audit_key_version` fields in storage allow old key versions to be retained for decryption while new data is encrypted with the current version.

---

### Vault State Machine

```
                 API start (no vault_state row)
                          │
                    ┌─────▼───────┐
                    │ uninitialized│  → GET /health: 200
                    │             │  → GET /ready: 503 (not initialized)
                    └─────┬───────┘  → all others: 503 (sealed)
                          │
               POST /vault/init (passphrase | envelope | file)
                          │
                    ┌─────▼───────┐
                    │  unsealed   │  → GET /health: 200 (incl. /health/)
                    │             │  → GET /ready: 200
                    └─────┬───────┘  → all routes: available
                          │
              SIGTERM / SIGINT / crash / SIGKILL
                          │
                    ┌─────▼───────┐
                    │   sealed    │  → GET /health: 200
                    │             │  → GET /ready: 503 (manual unseal required)
                    └─────┬───────┘  → all others: 503 (sealed)
                          │
             POST /vault/unseal (matching credentials for stored kms_type)
                          │
                    ┌─────▼───────┐
                    │  unsealed   │  (all routes available again)
                    └─────────────┘
```

**Key invariants:**
- `uninitialized` → `unsealed`: only via `POST /vault/init`; also creates `vault_state` row
- `sealed` → `unsealed`: only via `POST /vault/unseal` with the correct key file
- Any process termination: in-memory keys zeroed → state transitions to `sealed` on restart
- Auto-unseal on restart is **explicitly out of v1 scope** — document in `/ready` response while sealed
- There is no `sealed` → `uninitialized` transition — once initialized, always initialized

---

### Single-Row `vault_state` Enforcement

The `id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)` pattern guarantees at most one row:

```sql
-- First INSERT: succeeds
INSERT INTO vault_state (id, encrypted_sentinel, kms_type) VALUES (1, '...', 'file');

-- Second INSERT: fails with unique violation
INSERT INTO vault_state (id, encrypted_sentinel, kms_type) VALUES (1, '...', 'file');
-- ERROR: duplicate key value violates unique constraint "vault_state_pkey"

-- INSERT with different id: fails with check constraint
INSERT INTO vault_state (id, encrypted_sentinel, kms_type) VALUES (2, '...', 'file');
-- ERROR: new row for relation "vault_state" violates check constraint "vault_state_single_row"
```

Application-level check in `initVault()` (before INSERT) adds defense-in-depth and returns a user-friendly 409 instead of a raw PK violation.

---

### Sentinel Value and Verification

**Sentinel plaintext:** `"project-vault-sentinel-v1"` (25 bytes)

This is a fixed, known value. On unseal:
1. `decrypt(storedSentinel, derivedKey)` → if throws: wrong key → 401
2. `decrypted.toString('utf8') === 'project-vault-sentinel-v1'` → if false: bug (should be unreachable with correct GCM)

**Why GCM is self-verifying:** GCM is an authenticated encryption mode. The authentication tag is computed over the ciphertext + additional data during encryption. On decryption, `decipher.final()` recomputes the tag and compares using constant-time GHASH. If the tag doesn't match (wrong key, tampered ciphertext), it throws `ERR_CRYPTO_INVALID_AUTH_TAG`. This means verifying the sentinel plaintext after successful decryption is a secondary guard — the primary check is whether decryption throws.

**Sentinel is NOT secret.** Even if an attacker knows the sentinel value is `'project-vault-sentinel-v1'`, they cannot brute-force the master key from the stored ciphertext (AES-256-GCM with a 256-bit key and 128-bit tag is computationally infeasible to brute-force).

**`vault_state` integrity is a security boundary.** The sentinel verification at unseal only proves the supplied key matches whatever sentinel is stored. If an attacker gains write access to the database and replaces `encrypted_sentinel` with a ciphertext of their own, they can unseal with their key instead. Database write access to `vault_state` is therefore equivalent to vault compromise. Access to the `vault_state` table must be restricted to the `vault_app` role with no direct external access — this is already enforced by the `vault_app` role architecture, but must be verified in production hardening.

---

### Security: `statSync` → `readFileSync` Window (TOCTOU)

There is a small window between `statSync(resolved)` (size check) and `readFileSync(resolved)` (actual read) in which a file could be swapped or replaced on the filesystem. In production Docker deployments, secrets mounts are read-only bind mounts, making file replacement impossible in practice.

For environments where this is a concern, the fully atomic alternative is to open the file by file descriptor and use `fstatSync(fd)` + `readSync(fd)` on the same descriptor, eliminating any race between stat and read. This is not required for v1 but is documented here for future hardening.

---

### Security: Rate Limiting on Vault Endpoints

`POST /api/v1/vault/unseal` has no application-layer rate limiting. While `VAULT_KEY_DIR` confinement limits which files can be tried, repeated unseal attempts (with different files placed in the allowed directory) are detectable only via log analysis.

**Required deployment-level control:** The reverse proxy or load balancer in front of the API **must** enforce rate limiting on `/api/v1/vault/unseal` (e.g., nginx `limit_req` or equivalent). Recommended limit: ≤5 requests/minute per source IP. Document this in the operator runbook.

A follow-up story should add server-side rate limiting middleware (e.g., `@fastify/rate-limit`) specifically for vault management routes.

---

---

### Key Material Formats by Custody Model

#### Passphrase mode (primary — product decision)

- Operator supplies a **passphrase** (≥12 chars) in the JSON request body
- Argon2id derives 32-byte IKM; salt stored in `vault_state.key_derivation_params`
- No key files required — simplest dev/small-team UX

#### Envelope mode (production recommended)

- **Env half:** `VAULT_ENVELOPE_KEY_HALF` — 32 hex chars (16 bytes). Generate: `openssl rand -hex 16`
- **File half:** exactly 16 bytes at `envelopeKeyPath` within `VAULT_KEY_DIR`. Generate: `openssl rand -out envelope-half.bin 16`
- Neither half alone is sufficient — architecture-aligned split storage

#### File mode (downgraded — requires `acknowledgeCoLocationRisk: true`)

The `masterKeyPath` points to a file containing **raw binary bytes** (minimum 32 bytes) used directly as HKDF IKM.

**Common ways to generate the key file:**
```bash
# 32-byte random key (recommended — maximum entropy)
openssl rand -out vault-key.bin 32

# Or using dd:
dd if=/dev/urandom of=vault-key.bin bs=32 count=1
```

**Docker Compose integration** (documented for operators):
```yaml
services:
  api:
    volumes:
      - /path/on/host/vault-key.bin:/run/secrets/vault-key.bin:ro
    environment:
      # Optional: DEFAULT_MASTER_KEY_PATH for automated unsealing in dev
      # Never set this in production
```

**Important: the API does NOT trim the file content.** Raw bytes are used as-is. `fs.readFileSync(path)` returns a Buffer of exactly the file's byte content. If the file ends with a newline (common with text-mode tools), the newline is part of the key material. For integration tests, write exactly 32 bytes with no trailing newline: `writeFileSync(path, randomBytes(32))`.

---

### `generate-spec.ts` Bypass (vault guard disabled in dry-run)

`apps/api/src/scripts/generate-spec.ts` creates an app instance to extract the OpenAPI spec without touching a real database. Vault routes must appear in the spec even in dry-run mode.

```typescript
// generate-spec.ts
const app = await createApp({ logger: false })
// vaultGuardEnabled: false (default) — vault guard is NOT registered
// vaultRoutes ARE registered (always) — they appear in the spec
```

**Result:** `POST /api/v1/vault/init` and `POST /api/v1/vault/unseal` appear in the generated `openapi.json` and `api-types.ts`, but the guard is not active during spec generation.

---

### `no-bare-drizzle` Rule and `vault_state` Queries

The `vault_state` table is platform-level (no `org_id`), so it cannot use `withOrg()`. Use `withAdminAccess()` or direct `getDb()` queries. The key service is the only module that queries `vault_state`.

```typescript
// CORRECT: vault_state queries in key-service.ts use getDb() directly
// The no-bare-drizzle rule targets apps/api/src/**  — confirm the rule is
// applied only to the modules/* and routes/* directories, NOT lib/* and modules/vault/*
// (since vault/* cannot use withOrg() by design).
// If the rule fires on vault/key-service.ts, add it to the ESLint rule's allow-list.
```

---

### `route-audit.test.ts` Allow-List Update

```typescript
// apps/api/src/__tests__/route-audit.test.ts
// Add to the exempt paths list:
const EXEMPT_PATHS = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/vault/init',
  '/api/v1/vault/unseal',
  // auth routes added in Story 1.6:
  // '/api/v1/auth/login',
  // '/api/v1/auth/register',
  // '/api/v1/auth/refresh',
])
```

---

### RS256 vs HMAC-SHA256 Conflict (Architecture Is Authoritative)

Story 1.6 epics text says: *"the JWT is signed with RS256 (asymmetric)"*. The architecture document says: *"Web session JWTs: ≤5 min TTL, signed with HMAC-SHA256 (`@fastify/jwt`)"* [Source: architecture.md line 322].

**Resolution: architecture wins.** Story 1.6 must use HMAC-SHA256 via `@fastify/jwt` for web session JWTs. No RS256 key pair needs to be generated at vault init time.

RS256 / asymmetric keys are relevant for:
- Machine user exchange JWTs (≤1h TTL) — Story 7.x
- GitHub Actions OIDC integration — Story 7.3

If Story 1.6 implementation encounters this conflict, defer to architecture.md. Do NOT generate an RS256 key pair in Story 1.5 `initVault()`.

The `SESSION_SECRET` env var (for HMAC-SHA256) is wired in Story 1.6. No `vault_state` column is needed for JWT signing in Story 1.5.

---

### Audit Key Independence — Story 8.1 Dependency Note

The `getAuditKey()` function returns the derived audit encryption key. Story 8.1 ("Tamper-Evident Audit Log with HMAC Integrity") uses this key for encrypting audit payload fields and computing the HMAC chain:

```typescript
// How Story 8.1 will use the audit key:
import { getAuditKey } from '../vault/key-service.js'
import { encrypt } from '@project-vault/crypto'

const auditKey = getAuditKey()
const encryptedPayload = await encrypt(Buffer.from(JSON.stringify(payload)), auditKey)
```

The audit key has an independent `audit_key_version` lifecycle. When the audit key rotates (separate from the primary key), old entries encrypted under previous `audit_key_version` must remain decryptable. Old versions are retained in a `key_history` table (Story 9.x scope). This is architectural context — **do not implement key history in Story 1.5.**

---

### Packages/db `check-rls-coverage.ts` Allow-List

The `vault_state` table has no `org_id` and therefore no RLS policy. It must be added to the CI script's explicit allow-list to prevent a false positive failure:

```typescript
// packages/db/src/check-rls-coverage.ts
// Platform-level tables with no org_id column — exempt from RLS policy requirement.
const EXCLUDED_TABLES = new Set([
  'api_instances',  // Story 1.4 — platform heartbeat table
  'vault_state',    // Story 1.5 — single-row platform config (ADD THIS)
])
```

Note: `sessions` and `org_memberships` **do** have `org_id` and **must** have RLS policies (already created in `0001_rls_and_triggers.sql`). Do not add them to `EXCLUDED_TABLES`.

---

---

### File Changes Summary

| File | Action | Notes |
|---|---|---|
| `packages/crypto/src/passwords.ts` | CREATE | Argon2id master passphrase KDF |
| `packages/crypto/src/envelope.ts` | CREATE | Split-key envelope combination |
| `packages/crypto/package.json` | MODIFY | Add `argon2` runtime dependency |
| `packages/crypto/src/aes.ts` | CREATE | AES-256-GCM; internal only |
| `packages/crypto/src/kdf.ts` | CREATE | HKDF-SHA256 + HKDF_INFO constants |
| `packages/crypto/src/secret-value.ts` | CREATE | `SecretValue`, `withSecret()`, key lifecycle |
| `packages/crypto/src/index.ts` | MODIFY | Re-export from new modules; remove inline impl |
| `packages/crypto/src/index.test.ts` | MODIFY | Replace stub tests with full test suite |
| `packages/db/src/schema/vault-state.ts` | CREATE | Drizzle schema for vault_state |
| `packages/db/src/schema/index.ts` | MODIFY | Add vault-state export |
| `packages/db/src/migrations/0002_vault_state.sql` | CREATE | vault_state DDL |
| `packages/db/src/check-rls-coverage.ts` | MODIFY | Add `vault_state` to `EXCLUDED_TABLES` |
| `apps/api/src/modules/vault/key-service.ts` | CREATE | State machine: init, unseal, zeroKeys |
| `apps/api/src/modules/vault/routes.ts` | CREATE | POST /vault/init, POST /vault/unseal |
| `apps/api/src/modules/vault/schema.ts` | CREATE | Zod schemas for vault API |
| `apps/api/src/plugins/vault-guard.ts` | CREATE | onRequest sealed guard |
| `apps/api/src/routes/health.ts` | MODIFY | /ready reflects vault state |
| `apps/api/src/app.ts` | MODIFY | vaultGuardEnabled option, register vault plugin+routes |
| `apps/api/src/main.ts` | MODIFY | loadInitialVaultState() before createApp() |
| `apps/api/src/lib/shutdown.ts` | MODIFY | zeroKeys() before fastify.close() |
| `apps/api/src/config/env.ts` | MODIFY | DATABASE_URL superuser guard + VAULT_KEY_DIR |
| `apps/api/src/__tests__/vault-lifecycle.test.ts` | CREATE | Integration test: full lifecycle |
| `docker-compose.yml` | MODIFY | Mount `dev-secrets:/run/secrets:ro`, set `VAULT_KEY_DIR` |
| `docker-compose.prod.yml` | MODIFY | Mount `vault_keys:/run/secrets:ro`, set `VAULT_KEY_DIR` |
| `.env.example` | MODIFY | Document `VAULT_KEY_DIR` |
| `.gitignore` | MODIFY | Add `dev-secrets/` |
| `packages/eslint-config/rules/no-bare-decrypt.js` | MODIFY | Replace stub with real enforcement (AC-22) |
| `packages/eslint-config/index.js` | MODIFY | Two-tier bootstrapDecrypt allowlist |
| `apps/api/src/__tests__/vault-errors.test.ts` | CREATE | AppError response shape tests |
| `apps/api/src/plugins/redact-secrets.ts` | CREATE | Log redaction for passphrase/paths (AC-25) |
| `apps/api/src/__tests__/vault-log-redaction.test.ts` | CREATE | Assert passphrase never in logs |
| `apps/api/src/__tests__/helpers/vault-test-cleanup.ts` | CREATE | DB reset helper for integration tests |
| `apps/api/package.json` | MODIFY | Add `@fastify/rate-limit` dependency |
| `apps/api/Dockerfile` | MODIFY | Native build deps for `argon2` (AC-30) |

---

## Product Decisions (Resolved 2026-06-24)

| # | Question | Decision |
|---|---|---|
| 1 | Master key input format | **Passphrase + Argon2id KDF** as primary mode (`kms_type: 'passphrase'`). File mode retained as downgraded option. |
| 2 | Envelope encryption | **Include minimal envelope mode** in Story 1.5 — env half (`VAULT_ENVELOPE_KEY_HALF`) + file half (`envelopeKeyPath`). Recommended for production. |
| 3 | Vault endpoint auth | **Bootstrap token for first init** + firewall/network restriction (defense in depth) |
| 4 | Trailing slash on `/health/` | **Allow** — `normalizePath()` strips trailing slash before allowlist lookup. |
| 5 | Integration test DB reset | **`describe.sequential` + `beforeEach(resetVaultForTest())`** in vault-lifecycle.test.ts only. See AC-20. |
| 6 | Error code casing | **Lowercase snake_case** in JSON `error` field — canonical for all API errors going forward. |
| 7 | Init squatting (Red Team) | **`VAULT_BOOTSTRAP_TOKEN`** + `X-Vault-Bootstrap-Token` header; dev downgrade `VAULT_ALLOW_REMOTE_INIT=true` |
| 8 | Unseal brute force | **Server-side rate limit** 5 req/min/IP (`@fastify/rate-limit`) |
| 9 | Key file symlinks | **`lstatSync` + `O_NOFOLLOW`** — regular files only |
| 10 | `vault_state` tampering | **PostgreSQL trigger** blocks UPDATE/DELETE after insert |
| 11 | Passphrase in logs | **`redactBodyForLog()`** + integration test |
| 12 | FMEA: test state desync | **`loadInitialVaultState()` after truncate** (AC-26) |
| 13 | FMEA: DB down at startup | **Fail-fast exit 1** (AC-27) |
| 14 | FMEA: corrupt vault_state | **`503 vault_corrupted`** (AC-28) |
| 15 | FMEA: pg-boss while sealed | **Defer start until unsealed** (AC-29) |
| 16 | FMEA: argon2 native / tampered params | **Docker build deps + validateKeyDerivationParams** (AC-30) |

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6 (claude-sonnet-4-6)

### Debug Log References

- Docker runner stage initially crashed on startup with `VAULT_ENVELOPE_KEY_HALF must be 32 lowercase hex characters` because Compose's `${VAR:-}` interpolation yields `""` rather than unsetting the var; fixed via `z.preprocess` treating `""` as `undefined` in `env.ts`.
- `pnpm install --prod --ignore-scripts` in the Alpine runner skips argon2's native-binary install step; fixed with a targeted `pnpm rebuild argon2` after the ignore-scripts install (keeps root `prepare`/husky skipped while still building argon2's prebuild).
- `fastify.register(vaultGuardPlugin)` without `fastify-plugin` only applied the `onRequest` hook within its own encapsulation context, so sibling-registered routes and the 404 handler bypassed the guard; fixed by wrapping with `fp()`.
- Fastify's router treats `/health` and `/health/` as distinct routes by default; added `routerOptions: { ignoreTrailingSlash: true }` so AC-5's trailing-slash requirement holds.

### Completion Notes List

- [x] Passphrase mode (`kms_type: 'passphrase'`) implemented with Argon2id + salt stored in `key_derivation_params`
- [x] Envelope mode implemented with `VAULT_ENVELOPE_KEY_HALF` + 16-byte file half
- [x] File mode requires `acknowledgeCoLocationRisk: true` — documented as downgraded
- [x] Vault guard `normalizePath()` strips trailing slash — `/health/` returns 200 while sealed
- [x] Integration tests use `describe.sequential` + `beforeEach(resetVaultForTest())` — passphrase as primary path
- [x] API errors use lowercase snake_case in JSON `error` field
- [x] `packages/crypto` has `argon2` as only third-party runtime dependency (plus `node:crypto`)
- [x] `decrypt()` from `aes.ts` is NOT re-exported from `packages/crypto/src/index.ts` under the name `decrypt`
- [x] `bootstrapDecrypt` (alias for `decrypt`) IS exported from `index.ts` exclusively for vault/key-service.ts bootstrap use
- [x] `no-bare-decrypt` ESLint exception for `key-service.ts` allows `bootstrapDecrypt` only — NOT raw `decrypt`
- [x] `withSecret()` calls `decrypt()` from `aes.ts` via module-internal import (not through index.ts)
- [x] `withSecret()` zeroes the plaintext Buffer in `finally{}` regardless of whether `fn()` throws
- [x] `setVaultKey()` copies the Buffer (does NOT hold a reference to the caller's Buffer)
- [x] `getAuditKey()` returns `Buffer.from(_auditKey)` — a copy, not the module-level reference
- [x] `readKeyFile()`/`readKeyMaterialFile()` use `resolve(env.VAULT_KEY_DIR)` (normalized, not raw env string) for path confinement — prevents trailing-slash misconfiguration causing false rejections
- [x] `readKeyFile()`/`readKeyMaterialFile()` use `path.resolve()` + `env.VAULT_KEY_DIR` to confine key file paths; error message does NOT echo the supplied path
- [x] `readKeyMaterialFile()` calls `lstatSync()` before reading and rejects files > `MAX_KEY_FILE_BYTES` (4096) — uses `lstatSync` + `O_NOFOLLOW` `openSync`/`readSync` rather than `statSync`/`readFileSync`, per AC-7's stronger hardening requirement
- [x] `initVault()` uses `INSERT ... ON CONFLICT DO NOTHING ... .returning()` — atomic TOCTOU guard; zeros keys if another init won the race
- [x] `initVault()`: `keyMaterial.fill(0)` (i.e. `ikm.fill(0)`) called immediately after both keys are derived
- [x] `initVault()`: `primaryKey.fill(0)` called after `setVaultKey(primaryKey)`
- [x] `unsealVault()`: uses `bootstrapDecrypt` (static import from `@project-vault/crypto`) — NOT dynamic `await import('@project-vault/crypto/internal/aes')`
- [x] `unsealVault()`: `keyMaterial.fill(0)` called after derivation; primary + audit key zeroed on 401 path
- [x] `zeroKeys()` called BEFORE `fastify.close()` in SIGTERM/SIGINT handler (and in catch block)
- [x] `vault_state` has `CHECK (id = 1)` enforcing single row
- [x] `vault_state` added to `check-rls-coverage.ts` allow-list
- [x] `vault_state` migration created as `0003_vault_state.sql` — numbered 0003, not 0002, since `0002_audit_log_revoke.sql` already existed on this branch (NOT editing drizzle-generated `0000_*`)
- [x] Vault guard allowlist covers exactly: `GET /health`, `GET /ready`, `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`
- [x] `vaultGuardPlugin` NOT registered when `options.vaultGuardEnabled !== true` (protects `generate-spec.ts`)
- [ ] `POST /vault/init` and `POST /vault/unseal` added to `route-audit.test.ts` exempt list — NOT done: `route-audit.test.ts` is still a Story 1.11 `it.todo()` stub with no concrete `EXEMPT_PATHS` list to extend yet
- [x] `DATABASE_URL` superuser guard already exists from Story 1.4 — only `VAULT_KEY_DIR` (+ envelope/bootstrap vars) added in this story
- [x] `no-bare-decrypt` ESLint rule upgraded from stub to real enforcement (AC-22)
- [x] Global `AppError` error handler registered in `app.ts` (AC-15)
- [x] `docker-compose.yml` and `docker-compose.prod.yml` mount key volume read-only (AC-16)
- [x] `dev-secrets/` gitignored; operator curl ceremony documented in compose comments (AC-18)
- [x] Integration test uses `vault-test-cleanup.ts` helper; truncates `vault_state` between runs (AC-20)
- [x] `/metrics` returns 503 while sealed, available after unseal (AC-17)
- [x] `VAULT_KEY_DIR` env var defined with default `'/run/secrets'`; `readKeyMaterialFile()` uses it for path confinement
- [x] Vault init/unseal route handlers emit structured `req.log.info/warn` with `event` field on success and failure; `masterKeyPath` is never logged
- [x] Integration test sets `VAULT_KEY_DIR` to a `mkdtempSync` tmp dir for the whole file and removes it in `afterAll()` (no other test file touches `vault_state`, per AC-20)
- [x] Integration test sets `VAULT_KEY_DIR` to the `tmpDir` path so key file reads are within the allowed directory
- [x] HKDF_INFO constants exported from `kdf.ts` and used everywhere — never hardcoded info strings
- [x] `VAULT_BOOTSTRAP_TOKEN` + `X-Vault-Bootstrap-Token` required for init unless `VAULT_ALLOW_REMOTE_INIT=true` (AC-23)
- [x] `@fastify/rate-limit` on unseal route: 5 req/min/IP (AC-24)
- [x] `readKeyMaterialFile()` uses `lstatSync` + `O_NOFOLLOW` — rejects symlinks (AC-7)
- [x] `vault_state` UPDATE/DELETE triggers in migration (append-only, with a test-only `app.vault_test_reset` GUC bypass for integration cleanup)
- [x] `redactBodyForLog()` used in vault routes; log redaction test passes (AC-25)
- [x] `resetVaultForTest()` calls `loadInitialVaultState()` after DELETE (AC-26)
- [x] `loadInitialVaultState()` throws on DB unreachable — process exits before listen (AC-27)
- [x] Corrupt sentinel/params return `503 vault_corrupted` not 500 (AC-28)
- [x] `pg-boss` starts only after vault unsealed via `setOnVaultUnsealed` (AC-29)
- [x] `validateKeyDerivationParams()` rejects tampered Argon2 params (AC-30)
- [x] Dockerfile builder includes native deps for `argon2` package (AC-30); runner uses `pnpm install --ignore-scripts` + targeted `pnpm rebuild argon2` so the native binary still builds without running root's `prepare` (husky) script
- [x] `GET /health` returns 200 regardless of vault state; only `GET /ready` reflects vault state
- [x] RS256 key pair NOT generated in this story — HMAC-SHA256 is the architecture-authoritative JWT signing method
- [x] **Deviation from story snippets:** `VAULT_ALLOW_REMOTE_INIT`, `VAULT_BOOTSTRAP_TOKEN`, and `VAULT_ENVELOPE_KEY_HALF` are read live from `process.env` inside `key-service.ts` rather than from the cached `env` singleton (which still validates/documents them in `env.ts` for `.env.example`/startup-error purposes). `VAULT_KEY_DIR` still goes through the singleton. This keeps these three operator-facing toggles testable within a single process without `vi.resetModules()` gymnastics, and is harmless in production since they're set once at container start either way.

### File List

**Created:**
- `packages/crypto/src/types.ts`
- `packages/crypto/src/aes.ts`
- `packages/crypto/src/kdf.ts`
- `packages/crypto/src/secret-value.ts`
- `packages/crypto/src/passwords.ts`
- `packages/crypto/src/passwords.test.ts`
- `packages/crypto/src/envelope.ts`
- `packages/crypto/src/envelope.test.ts`
- `packages/db/src/schema/vault-state.ts`
- `packages/db/src/migrations/0003_vault_state.sql`
- `apps/api/src/modules/vault/key-service.ts`
- `apps/api/src/modules/vault/routes.ts`
- `apps/api/src/modules/vault/schema.ts`
- `apps/api/src/plugins/vault-guard.ts`
- `apps/api/src/plugins/vault-guard.test.ts`
- `apps/api/src/plugins/redact-secrets.ts`
- `apps/api/src/__tests__/vault-lifecycle.test.ts`
- `apps/api/src/__tests__/vault-errors.test.ts`
- `apps/api/src/__tests__/vault-log-redaction.test.ts`
- `apps/api/src/__tests__/helpers/vault-test-cleanup.ts`
- `apps/api/src/lib/shutdown.test.ts`
- `dev-secrets/.gitkeep`

**Modified:**
- `packages/crypto/src/index.ts`
- `packages/crypto/src/index.test.ts`
- `packages/crypto/package.json` (added `argon2` dependency)
- `packages/db/src/schema/index.ts`
- `packages/db/src/check-rls-coverage.ts`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/package.json` (added `./schema` export)
- `apps/api/src/app.ts` (vaultGuardEnabled option, global AppError handler, vaultRoutes registration, ignoreTrailingSlash)
- `apps/api/src/main.ts` (loadInitialVaultState, setOnVaultUnsealed)
- `apps/api/src/lib/shutdown.ts` (zeroKeys before close)
- `apps/api/src/lib/fastify-app.ts` (added setErrorHandler, log.warn to the FastifyApp type)
- `apps/api/src/routes/health.ts` (/ready vault-state branches)
- `apps/api/src/routes/health.test.ts` (mock vault key-service for DB-branch tests)
- `apps/api/src/config/env.ts` (VAULT_KEY_DIR, VAULT_ENVELOPE_KEY_HALF, VAULT_BOOTSTRAP_TOKEN, VAULT_ALLOW_REMOTE_INIT)
- `apps/api/src/config/env.test.ts` (merged into one describe block; added VAULT_KEY_DIR test)
- `apps/api/src/lib/cors.test.ts` (updated for new generic 500 error shape)
- `apps/api/package.json` (added @project-vault/crypto, fastify-plugin, drizzle-orm dependencies)
- `apps/api/vitest.config.ts` (expanded coverage include list)
- `apps/api/Dockerfile` (argon2 native build deps; pnpm rebuild argon2 in runner)
- `packages/eslint-config/rules/no-bare-decrypt.js` (real rule implementation)
- `packages/eslint-config/index.js` (two-tier bootstrapDecrypt allowlist)
- `pnpm-workspace.yaml` (onlyBuiltDependencies/allowBuilds for argon2)
- `docker-compose.yml` (dev-secrets mount, VAULT_KEY_DIR/VAULT_ENVELOPE_KEY_HALF env, operator comment block)
- `docker-compose.dev.yml` (VAULT_ALLOW_REMOTE_INIT=true dev convenience)
- `docker-compose.prod.yml` (vault_keys volume mount)
- `.env.example` (VAULT_KEY_DIR, VAULT_ENVELOPE_KEY_HALF, VAULT_BOOTSTRAP_TOKEN, VAULT_ALLOW_REMOTE_INIT docs)
- `.gitignore` (dev-secrets/ exclusion with .gitkeep exception)

### Change Log

- 2026-06-25: Implemented full vault initialization and master-key management — AES-256-GCM/HKDF/Argon2id crypto layer, three-custody-model init/unseal state machine, vault guard middleware, bootstrap-token protection, unseal rate limiting, append-only `vault_state` with test-only reset bypass, FMEA hardening (fail-fast startup, corrupted-state handling, deferred pg-boss start), real `no-bare-decrypt` lint enforcement, and Docker/Compose wiring for envelope/file key material. All quality gates (build, typecheck, lint, test, jscpd) pass monorepo-wide; verified end-to-end against the live Docker stack.
