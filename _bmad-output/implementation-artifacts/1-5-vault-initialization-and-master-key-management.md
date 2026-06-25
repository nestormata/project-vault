# Story 1.5: Vault Initialization & Master Key Management

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

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
**Then** `packages/crypto` provides a fully functional cryptographic layer with zero third-party runtime dependencies (only `node:crypto`).

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

#### AC-1e: Updated `packages/crypto/src/index.ts`

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

    // Key custody model: 'file' = mounted file path; 'envelope' = split key (v1.1); 'kms' = KMS (v2)
    kmsType: text('kms_type').notNull(),

    initializedAt: timestamp('initialized_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('vault_state_single_row', sql`${table.id} = 1`),
    check('vault_state_kms_type_check', sql`${table.kmsType} IN ('file', 'envelope', 'kms')`),
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
  initialized_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT vault_state_single_row CHECK (id = 1),
  CONSTRAINT vault_state_kms_type_check CHECK (kms_type IN ('file', 'envelope', 'kms'))
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
```

**Add `vault_state` to the `check-rls-coverage.ts` allow-list** in `packages/db/scripts/check-rls-coverage.ts` (alongside `sessions`, `refresh_tokens`, `api_instances`).

---

### AC-3: Vault Key Service — Init Path

**Given** no `vault_state` row exists in the database,
**When** `POST /api/v1/vault/init` is called with `{ "masterKeyPath": "/path/to/key.bin" }`,
**Then:**

1. API reads the file at `masterKeyPath` using `fs.readFileSync(masterKeyPath)` → `Buffer`
2. Validates: `keyMaterial.length >= 32` — throws `400 { error: "INVALID_KEY_FILE", message: "Key file must be at least 32 bytes" }` if shorter
3. Derives primary key: `deriveKey(keyMaterial, HKDF_INFO.PRIMARY)` → 32-byte `Buffer`
4. Derives audit key: `deriveKey(keyMaterial, HKDF_INFO.AUDIT_LOG)` → 32-byte `Buffer`
5. Encrypts sentinel `Buffer.from('project-vault-sentinel-v1', 'utf8')` with primary key → `EncryptedValue`
6. Stores `vault_state` row:
   ```
   { id: 1, key_version: 1, audit_key_version: 1,
     encrypted_sentinel: JSON.stringify(encryptedSentinel),
     kms_type: 'file', initialized_at: NOW() }
   ```
   **Note:** `kms_type` is hardcoded to `'file'` in v1. Future stories implementing envelope or KMS custody must add a `kmsType` parameter to the init request. Do NOT add that parameter now — it is out of v1 scope.
7. Calls `setVaultKey(primaryKey)` to inject the key into `packages/crypto`'s module-level store
8. Sets internal vault status to `'unsealed'`
9. Returns `200 { initialized: true, keyVersion: 1 }`

**And** route handler emits structured log on success: `{ event: 'vault.init', keyVersion: 1, kmsType: 'file' }` and on failure: `{ event: 'vault.init.failed', error: '<message>' }` — `masterKeyPath` is **never** included in logs.

**And** if `vault_state` row already exists, returns `409 { error: "already_initialized", message: "Vault is already initialized. Use POST /api/v1/vault/unseal to unseal." }`

**And** if the file at `masterKeyPath` cannot be read or falls outside the allowed `VAULT_KEY_DIR`, returns `400 { error: "KEY_FILE_NOT_FOUND", message: "Cannot read key file at path: <redacted>" }` — the supplied path is never echoed back.

**And** the master key bytes **never appear in any log, database column, or response body** — only the encrypted sentinel (ciphertext) is stored; the raw `keyMaterial` Buffer is zeroed after key derivation:
```typescript
// After deriving both keys from keyMaterial:
keyMaterial.fill(0)  // zero the raw file bytes — never needed again
```

---

### AC-4: Vault Key Service — Unseal Path

**Given** a `vault_state` row exists and the vault is in `sealed` state (API restarted after a crash or shutdown),
**When** `POST /api/v1/vault/unseal` is called with `{ "masterKeyPath": "/path/to/key.bin" }`,
**Then:**

1. If vault is already `unsealed`: return `400 { error: "ALREADY_UNSEALED", message: "Vault is already unsealed." }`
2. Read file at `masterKeyPath`
3. Validate minimum 32 bytes
4. Load `vault_state` row from database
5. Derive primary key: `deriveKey(keyMaterial, HKDF_INFO.PRIMARY)`
6. Parse stored sentinel: `JSON.parse(vaultState.encryptedSentinel)` → `EncryptedValue`
7. Decrypt sentinel using derived primary key
   - If `decrypt()` throws (GCM auth tag mismatch = wrong key): return `401 { error: "UNSEAL_FAILED", message: "Vault unseal failed: key file does not match stored vault configuration." }`
   - Compare decrypted plaintext to `'project-vault-sentinel-v1'`
   - If plaintext mismatches: return `401` (should be unreachable with correct AES-GCM implementation)
8. Derive audit key: `deriveKey(keyMaterial, HKDF_INFO.AUDIT_LOG)`
9. Call `setVaultKey(primaryKey)` — injects into module-level store
10. Store audit key in module-level store separately (see Dev Notes on dual-key storage)
11. Zero `keyMaterial` buffer
12. Set vault status to `unsealed`
13. Return `200 { unsealed: true, keyVersion: vaultState.keyVersion }`

**And** route handler emits structured log on success: `{ event: 'vault.unseal', keyVersion: N }` and on failure: `{ event: 'vault.unseal.failed', error: '<message>' }` — `masterKeyPath` is **never** included in logs.

**And** the `/ready` endpoint transitions from `503` to `200` immediately after successful unseal.

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

// Exact path+method pairs that bypass the vault guard — no wildcards
const VAULT_GUARD_ALLOWLIST = new Set([
  'GET /health',
  'GET /ready',
  'POST /api/v1/vault/init',
  'POST /api/v1/vault/unseal',
])

export async function vaultGuardPlugin(fastify: FastifyApp): Promise<void> {
  fastify.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]            // strip query string
    const routeKey = `${req.method} ${path}`
    if (VAULT_GUARD_ALLOWLIST.has(routeKey)) return  // passthrough

    const vaultStatus = getVaultStatus()
    if (vaultStatus !== 'unsealed') {
      return reply.status(503).send({ status: 'sealed', message: 'Vault not initialized' })
    }
  })
}
```

**CRITICAL: `vaultGuardPlugin` must NOT be registered in `generate-spec.ts`** dry-run mode (see AC-13).

---

### AC-6: `POST /api/v1/vault/init` Route

```typescript
// apps/api/src/modules/vault/schema.ts
import { z } from 'zod/v4'

export const VaultInitRequestSchema = z.object({
  masterKeyPath: z.string().min(1, 'masterKeyPath is required'),
})

export const VaultInitResponseSchema = z.object({
  initialized: z.literal(true),
  keyVersion: z.number().int().positive(),
})

export const VaultUnsealRequestSchema = z.object({
  masterKeyPath: z.string().min(1, 'masterKeyPath is required'),
})

export const VaultUnsealResponseSchema = z.object({
  unsealed: z.literal(true),
  keyVersion: z.number().int().positive(),
})
```

```typescript
// apps/api/src/modules/vault/routes.ts
import type { FastifyApp } from '../../lib/fastify-app.js'
import { initVault, unsealVault } from './key-service.js'
import {
  VaultInitRequestSchema,
  VaultInitResponseSchema,
  VaultUnsealRequestSchema,
  VaultUnsealResponseSchema,
} from './schema.js'

export async function vaultRoutes(fastify: FastifyApp): Promise<void> {
  fastify.post('/api/v1/vault/init', {
    schema: {
      body: VaultInitRequestSchema,
      response: { 200: VaultInitResponseSchema },
      tags: ['vault'],
      summary: 'Initialize the vault with a master key file',
    },
  }, async (req, reply) => {
    try {
      const result = await initVault(req.body.masterKeyPath)
      req.log.info(
        { event: 'vault.init', keyVersion: result.keyVersion, kmsType: 'file' },
        'Vault initialized successfully'
      )
      return reply.status(200).send(result)
    } catch (err) {
      req.log.warn(
        { event: 'vault.init.failed', error: err instanceof Error ? err.message : String(err) },
        'Vault init failed'
      )
      throw err
    }
  })

  fastify.post('/api/v1/vault/unseal', {
    schema: {
      body: VaultUnsealRequestSchema,
      response: { 200: VaultUnsealResponseSchema },
      tags: ['vault'],
      summary: 'Unseal the vault after restart using the master key file',
    },
  }, async (req, reply) => {
    try {
      const result = await unsealVault(req.body.masterKeyPath)
      req.log.info(
        { event: 'vault.unseal', keyVersion: result.keyVersion },
        'Vault unsealed successfully'
      )
      return reply.status(200).send(result)
    } catch (err) {
      req.log.warn(
        { event: 'vault.unseal.failed', error: err instanceof Error ? err.message : String(err) },
        'Vault unseal failed — verify key file is correct'
        // NOTE: masterKeyPath is intentionally NOT logged — filesystem layout disclosure
      )
      throw err
    }
  })
}
```

**NOTE**: These routes are NOT wrapped in `SecureRoute` — they are explicitly excluded from the `secureRoutes` Set audit. The `route-audit.test.ts` allow-list must include `/api/v1/vault/init` and `/api/v1/vault/unseal` alongside `/health`, `/metrics`, `/api/v1/auth/*`. [Source: architecture.md#Enforcement Guidelines]

---

### AC-7: `apps/api/src/modules/vault/key-service.ts` — State Machine

The key service manages the in-memory vault lifecycle. It is the only module that holds derived key buffers.

```typescript
// apps/api/src/modules/vault/key-service.ts
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
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

/** Call once at API startup to determine initial vault state from DB. */
export async function loadInitialVaultState(): Promise<VaultStatus> {
  const db = getDb()
  const rows = await db.select().from(vaultState).limit(1)
  _status = rows.length === 0 ? 'uninitialized' : 'sealed'
  return _status
}

const MAX_KEY_FILE_BYTES = 4096  // no legitimate key file needs more than this

/** Read master key file — validates path confinement, file size, and minimum length. */
function readKeyFile(masterKeyPath: string): Buffer {
  // Path confinement: key files must reside within VAULT_KEY_DIR.
  // Prevents arbitrary file read if a crafted masterKeyPath is supplied.
  const allowedDir = resolve(env.VAULT_KEY_DIR)  // normalize: strips trailing slash, resolves symlinks in dir path
  const resolved = resolve(masterKeyPath)
  if (!resolved.startsWith(allowedDir + '/') && resolved !== allowedDir) {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }

  // Check file size BEFORE reading to prevent OOM via /dev/urandom or large files.
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(resolved)
  } catch {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }
  if (stat.size > MAX_KEY_FILE_BYTES) {
    throw new AppError(
      'INVALID_KEY_FILE',
      `Key file exceeds maximum allowed size (${MAX_KEY_FILE_BYTES} bytes)`,
      400
    )
  }

  let keyMaterial: Buffer
  try {
    keyMaterial = readFileSync(resolved)
  } catch {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }
  if (keyMaterial.length < 32) {
    keyMaterial.fill(0)
    throw new AppError(
      'INVALID_KEY_FILE',
      `Key file must be at least 32 bytes, got ${keyMaterial.length}`,
      400
    )
  }
  return keyMaterial
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
import { loadInitialVaultState } from './modules/vault/key-service.js'
import { env } from './config/env.js'
import postgres from 'postgres'

async function main(): Promise<void> {
  const emitter = createEventEmitter()
  const _ringBuffer = null  // Story 1.11

  const sql = postgres(env.DATABASE_URL)

  // Check vault state from DB before starting server
  // Sets _status to 'uninitialized' or 'sealed' — never throws
  const initialVaultStatus = await loadInitialVaultState()
  process.stderr.write(`[vault] Initial status: ${initialVaultStatus}\n`)

  const fastify = await createApp({
    dbPool: { query: async (statement: string) => sql.unsafe(statement) },
    vaultGuardEnabled: true,
  })

  const boss = new BossService(env.DATABASE_URL)
  fastify.addHook('onReady', async () => { await boss.start() })
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

**Note:** This test requires a real PostgreSQL instance. Add it to the `integration` Vitest workspace or use the `.env.test` `DATABASE_URL`.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createApp } from '../app.js'

describe('Vault lifecycle: init → API sealed → unseal → API available', () => {
  let tmpDir: string
  let keyFilePath: string
  let originalVaultKeyDir: string | undefined

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'))
    keyFilePath = join(tmpDir, 'test-key.bin')
    // VAULT_KEY_DIR confinement: readKeyFile() rejects paths outside this directory.
    // Override the default /run/secrets to allow reads from the test tmpDir.
    originalVaultKeyDir = process.env['VAULT_KEY_DIR']
    process.env['VAULT_KEY_DIR'] = tmpDir
    // Write a 32-byte random key file
    writeFileSync(keyFilePath, randomBytes(32))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    // Restore original env — prevents VAULT_KEY_DIR contamination of subsequent test workers
    if (originalVaultKeyDir === undefined) {
      delete process.env['VAULT_KEY_DIR']
    } else {
      process.env['VAULT_KEY_DIR'] = originalVaultKeyDir
    }
  })

  it('returns 503 on any route before initialization', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/api/v1/some-future-route' })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ status: 'sealed' })
    await app.close()
  })

  it('GET /health always returns 200 even when sealed', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('GET /ready returns 503 with reason=sealed when uninitialized', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.reason).toBe('sealed')
    await app.close()
  })

  it('POST /vault/init succeeds and returns { initialized: true, keyVersion: 1 }', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true, /* real db */ })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/init',
      body: { masterKeyPath: keyFilePath },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.initialized).toBe(true)
    expect(body.keyVersion).toBe(1)
    await app.close()
  })

  it('POST /vault/init a second time returns 409', async () => {
    // Re-use same app that was already initialized in previous test
    // (vault_state row persists in test DB)
    const app = await createApp({ logger: false, vaultGuardEnabled: true, /* real db */ })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/init',
      body: { masterKeyPath: keyFilePath },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'already_initialized' })
    await app.close()
  })

  it('POST /vault/unseal with correct key succeeds and returns { unsealed: true }', async () => {
    // New app instance = vault starts sealed (existing vault_state row)
    const app = await createApp({ logger: false, vaultGuardEnabled: true, /* real db */ })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      body: { masterKeyPath: keyFilePath },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ unsealed: true })
    await app.close()
  })

  it('POST /vault/unseal with WRONG key returns 401', async () => {
    const wrongKeyPath = join(tmpDir, 'wrong-key.bin')
    writeFileSync(wrongKeyPath, randomBytes(32))  // different random bytes
    const app = await createApp({ logger: false, vaultGuardEnabled: true, /* real db */ })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      body: { masterKeyPath: wrongKeyPath },
    })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'UNSEAL_FAILED' })
    await app.close()
  })

  it('after unseal, regular routes are no longer blocked', async () => {
    const app = await createApp({ logger: false, vaultGuardEnabled: true, /* real db */ })
    // Unseal first
    await app.inject({
      method: 'POST', url: '/api/v1/vault/unseal',
      body: { masterKeyPath: keyFilePath },
    })
    // Now any route should NOT return 503 (may 404 if not registered, but not 503)
    const res = await app.inject({ method: 'GET', url: '/api/v1/some-future-route' })
    expect(res.statusCode).not.toBe(503)
    await app.close()
  })
})
```

---

### AC-14: `env.ts` — Superuser Guard

**Given** Story 1.4 mandated a startup guard rejecting `DATABASE_URL` with `postgres` username,
**When** the API starts with `DATABASE_URL=postgresql://postgres:...@host/db`,
**Then** the process exits with an error message: `"DATABASE_URL must not use 'postgres' superuser — RLS is bypassed for superuser connections. Use the 'vault_app' role instead."`

```typescript
// Additions to apps/api/src/config/env.ts envSchema:

// VAULT_KEY_DIR: the only directory from which master key files may be read.
// readKeyFile() resolves the supplied path and rejects any path outside this directory.
// Default: /run/secrets — the conventional Docker secrets mount point.
// Set to an absolute path; trailing slash is handled by path.resolve() normalization.
VAULT_KEY_DIR: z.string().min(1).default('/run/secrets'),

DATABASE_URL: z.string().min(1).refine((url) => {
  // Guard: superuser 'postgres' role bypasses ALL PostgreSQL RLS policies.
  // All app queries must connect as vault_app (or equivalent non-superuser role).
  try {
    const parsed = new URL(url)
    return parsed.username !== 'postgres'
  } catch {
    return true // malformed URL — other validation will catch it
  }
}, "DATABASE_URL must not use 'postgres' superuser — RLS is bypassed for superuser connections. Use the 'vault_app' role instead."),
```

---

## Tasks / Subtasks

- [ ] **Task 1: Implement `packages/crypto` core primitives** (AC: 1a–1e)
  - [ ] Create `packages/crypto/src/types.ts` — `EncryptedValue` type (moved from index.ts)
  - [ ] Create `packages/crypto/src/aes.ts` — `encrypt()` + internal `decrypt()`; versioned ciphertext; no external dependencies
  - [ ] Create `packages/crypto/src/kdf.ts` — `deriveKey()` via `hkdfSync`; `HKDF_INFO` constants
  - [ ] Create `packages/crypto/src/secret-value.ts` — `SecretValue`, module-level `_activeKey`, `setVaultKey()`, `clearVaultKey()`, `isVaultKeySet()`, `withSecret()` with real decryption + Buffer zeroing in `finally`
  - [ ] Update `packages/crypto/src/index.ts` — re-export from new modules; confirm `decrypt()` is NOT exported under the name `decrypt`; export `decrypt as bootstrapDecrypt` for vault key-service bootstrap use only
  - [ ] Run `pnpm --filter @project-vault/crypto build && pnpm --filter @project-vault/crypto typecheck`

- [ ] **Task 2: `vault_state` Drizzle schema + migration** (AC: 2a–2b)
  - [ ] Create `packages/db/src/schema/vault-state.ts` — single-row table with CHECK constraint
  - [ ] Add `export * from './vault-state.js'` to `packages/db/src/schema/index.ts`
  - [ ] Create `packages/db/src/migrations/0002_vault_state.sql` — DDL with CHECK constraints and COMMENT
  - [ ] Add `vault_state` to `check-rls-coverage.ts` allow-list
  - [ ] Run `pnpm --filter @project-vault/db db:migrate` (on fresh test DB) — verify no errors

- [ ] **Task 3: Key service module** (AC: 3, 4, 7)
  - [ ] Create `apps/api/src/modules/vault/key-service.ts` — three-state machine (`uninitialized`, `sealed`, `unsealed`), `initVault()`, `unsealVault()`, `loadInitialVaultState()`, `getAuditKey()`, `zeroKeys()`
  - [ ] Confirm: `readKeyFile()` uses `path.resolve()` + `env.VAULT_KEY_DIR` confinement check before `readFileSync`
  - [ ] Confirm: `readKeyFile()` calls `statSync()` and rejects files > 4096 bytes before reading
  - [ ] Confirm: `initVault()` uses `INSERT ... ON CONFLICT DO NOTHING` + `.returning()` to atomically guard against TOCTOU race
  - [ ] Confirm: `getAuditKey()` returns `Buffer.from(_auditKey)` — a copy, not the module-level reference
  - [ ] Confirm: `unsealVault()` uses `bootstrapDecrypt` (static import) — not dynamic `import('@project-vault/crypto/internal/aes')`
  - [ ] Confirm: raw `keyMaterial` Buffer is zeroed immediately after both keys are derived in both `initVault()` and `unsealVault()`
  - [ ] Confirm: `primaryKey` buffer is zeroed after `setVaultKey()` call (which takes its own copy)

- [ ] **Task 4: Vault routes** (AC: 6)
  - [ ] Create `apps/api/src/modules/vault/schema.ts` — Zod schemas for init/unseal request+response
  - [ ] Create `apps/api/src/modules/vault/routes.ts` — `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`
  - [ ] Confirm: both route handlers emit structured `req.log.info/warn` on success and failure with `event` field; `masterKeyPath` is NEVER logged
  - [ ] Add `vaultRoutes` to allow-list in `apps/api/src/__tests__/route-audit.test.ts`

- [ ] **Task 5: Vault guard plugin** (AC: 5)
  - [ ] Create `apps/api/src/plugins/vault-guard.ts` — `onRequest` hook with exact allowlist
  - [ ] Confirm: allowlist uses `req.url.split('?')[0]` to strip query params

- [ ] **Task 6: Update `apps/api/src/app.ts`** (AC: 11)
  - [ ] Add `vaultGuardEnabled?: boolean` to `AppOptions`
  - [ ] Register `vaultGuardPlugin` only when `options.vaultGuardEnabled === true`
  - [ ] Register `vaultRoutes` always (must appear in OpenAPI spec)
  - [ ] Update `scripts/generate-spec.ts` — verify it calls `createApp({ logger: false })` WITHOUT `vaultGuardEnabled: true` (this is the default; no change needed if already omitting it)

- [ ] **Task 7: Update `GET /ready` health route** (AC: 8)
  - [ ] Modify `apps/api/src/routes/health.ts` to import `getVaultStatus` from key-service
  - [ ] Three-branch response: `uninitialized` → 503 "not initialized", `sealed` → 503 "manual unseal required", `unsealed` → standard DB check

- [ ] **Task 8: Update `apps/api/src/main.ts` startup sequence** (AC: 10)
  - [ ] Call `loadInitialVaultState()` after DB connection, before `createApp()`
  - [ ] Log initial vault status via `process.stderr.write`
  - [ ] Pass `vaultGuardEnabled: true` to `createApp()`

- [ ] **Task 9: Update `apps/api/src/lib/shutdown.ts`** (AC: 9)
  - [ ] Import `zeroKeys` from `key-service.ts`
  - [ ] Call `zeroKeys()` BEFORE `fastify.close()` in SIGTERM/SIGINT handler
  - [ ] Call `zeroKeys()` in the catch block too (defensive)

- [ ] **Task 10: Add `DATABASE_URL` superuser guard and `VAULT_KEY_DIR` to `env.ts`** (AC: 14)
  - [ ] Add `.refine()` on `DATABASE_URL` that parses the URL and rejects `username === 'postgres'`
  - [ ] Add `VAULT_KEY_DIR` env var with default `'/run/secrets'`

- [ ] **Task 11: Unit tests for `packages/crypto`** (AC: 12)
  - [ ] Replace stub tests in `packages/crypto/src/index.test.ts` with the full test suite from AC-12
  - [ ] Run `pnpm --filter @project-vault/crypto test` — all tests pass

- [ ] **Task 12: Integration test — vault lifecycle** (AC: 13)
  - [ ] Create `apps/api/src/__tests__/vault-lifecycle.test.ts`
  - [ ] Configure test to use a real PostgreSQL test DB (`.env.test` `DATABASE_URL`)
  - [ ] All 7 scenarios pass: sealed 503, health always 200, ready 503/unsealed, init success, double init 409, unseal success, wrong key 401, post-unseal routes unblocked

- [ ] **Task 13: Quality gates**
  - [ ] `pnpm --filter @project-vault/crypto build` — zero TypeScript errors
  - [ ] `pnpm --filter @project-vault/crypto test` — all unit tests pass
  - [ ] `pnpm --filter @project-vault/db typecheck` — vault-state schema clean
  - [ ] `pnpm --filter @project-vault/api typecheck` — zero TS errors
  - [ ] `pnpm --filter @project-vault/api test` — unit + integration tests pass
  - [ ] `pnpm lint` — no ESLint errors (especially `no-bare-decrypt` rule)
  - [ ] `pnpm build` — monorepo builds successfully
  - [ ] `pnpm jscpd` — no duplication threshold exceeded

---

## Dev Notes

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

**Integration test override:** Set `VAULT_KEY_DIR` to the `tmpDir` value used by `vault-lifecycle.test.ts` so `writeFileSync(keyFilePath, randomBytes(32))` is within the allowed directory.

**Max file size guard:** `statSync(resolved)` is called before `readFileSync`. Files larger than `MAX_KEY_FILE_BYTES` (4096) are rejected before any read — prevents OOM via `/dev/urandom` or multi-GB files.

---

### Security: Vault Init/Unseal Endpoints — No Application-Layer Auth

`POST /api/v1/vault/init` and `POST /api/v1/vault/unseal` are intentionally excluded from the `SecureRoute` auth middleware (they run before auth is available). This means they have **no application-layer authentication**.

**Required deployment-level mitigation (mandatory for production):**

1. **Network isolation (preferred):** Bind vault management routes to a separate internal-only port or firewall them to `localhost` / a management VLAN. These endpoints must not be reachable from the public internet.
2. **`VAULT_KEY_DIR` confinement (already in story):** Even if an attacker can call the endpoint, they can only reference files within the allowed directory.
3. **Docker Compose / Kubernetes:** Mount the key file at `/run/secrets/vault-key.bin` as a read-only volume. The operator calls `POST /vault/init` or `POST /vault/unseal` from within the cluster network only.

**Document in operator runbook** that vault endpoints must be network-restricted before production deployment. A follow-up story (post-v1) may add a one-time `VAULT_INIT_TOKEN` env var for an additional auth layer.

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
               POST /vault/init (masterKeyPath valid + ≥32 bytes)
                          │
                    ┌─────▼───────┐
                    │  unsealed   │  → GET /health: 200
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
             POST /vault/unseal (correct masterKeyPath)
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

### Key File Format and Minimum Size

The `masterKeyPath` points to a file containing **raw binary bytes** (minimum 32 bytes). These bytes are used directly as the HKDF IKM.

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
// packages/db/scripts/check-rls-coverage.ts
// Add vault_state to the no-org-id table allow-list alongside:
const NO_ORG_RLS_EXEMPT = new Set([
  'sessions',
  'refresh_tokens',
  'api_instances',
  'vault_state',   // ← ADD THIS: platform-level single-row config table
])
```

---

### File Changes Summary

| File | Action | Notes |
|---|---|---|
| `packages/crypto/src/types.ts` | CREATE | `EncryptedValue` type |
| `packages/crypto/src/aes.ts` | CREATE | AES-256-GCM; internal only |
| `packages/crypto/src/kdf.ts` | CREATE | HKDF-SHA256 + HKDF_INFO constants |
| `packages/crypto/src/secret-value.ts` | CREATE | `SecretValue`, `withSecret()`, key lifecycle |
| `packages/crypto/src/index.ts` | MODIFY | Re-export from new modules; remove inline impl |
| `packages/crypto/src/index.test.ts` | MODIFY | Replace stub tests with full test suite |
| `packages/db/src/schema/vault-state.ts` | CREATE | Drizzle schema for vault_state |
| `packages/db/src/schema/index.ts` | MODIFY | Add vault-state export |
| `packages/db/src/migrations/0002_vault_state.sql` | CREATE | vault_state DDL |
| `packages/db/scripts/check-rls-coverage.ts` | MODIFY | Add vault_state to exempt list |
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
| `apps/api/src/__tests__/route-audit.test.ts` | MODIFY | Add vault routes to exempt list |

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

- [ ] `packages/crypto` has no third-party runtime dependencies — `node:crypto` only
- [ ] `decrypt()` from `aes.ts` is NOT re-exported from `packages/crypto/src/index.ts` under the name `decrypt`
- [ ] `bootstrapDecrypt` (alias for `decrypt`) IS exported from `index.ts` exclusively for vault/key-service.ts bootstrap use
- [ ] `no-bare-decrypt` ESLint exception for `key-service.ts` allows `bootstrapDecrypt` only — NOT raw `decrypt`
- [ ] `withSecret()` calls `decrypt()` from `aes.ts` via module-internal import (not through index.ts)
- [ ] `withSecret()` zeroes the plaintext Buffer in `finally{}` regardless of whether `fn()` throws
- [ ] `setVaultKey()` copies the Buffer (does NOT hold a reference to the caller's Buffer)
- [ ] `getAuditKey()` returns `Buffer.from(_auditKey)` — a copy, not the module-level reference
- [ ] `readKeyFile()` uses `resolve(env.VAULT_KEY_DIR)` (normalized, not raw env string) for path confinement — prevents trailing-slash misconfiguration causing false rejections
- [ ] `readKeyFile()` uses `path.resolve()` + `env.VAULT_KEY_DIR` to confine key file paths; error message does NOT echo the supplied path
- [ ] `readKeyFile()` calls `statSync()` before `readFileSync()` and rejects files > `MAX_KEY_FILE_BYTES` (4096)
- [ ] `initVault()` uses `INSERT ... ON CONFLICT DO NOTHING ... .returning()` — atomic TOCTOU guard; zeros keys if another init won the race
- [ ] `initVault()`: `keyMaterial.fill(0)` called immediately after both keys are derived
- [ ] `initVault()`: `primaryKey.fill(0)` called after `setVaultKey(primaryKey)`
- [ ] `unsealVault()`: uses `bootstrapDecrypt` (static import from `@project-vault/crypto`) — NOT dynamic `await import('@project-vault/crypto/internal/aes')`
- [ ] `unsealVault()`: `keyMaterial.fill(0)` called after derivation; primary + audit key zeroed on 401 path
- [ ] `zeroKeys()` called BEFORE `fastify.close()` in SIGTERM/SIGINT handler (and in catch block)
- [ ] `vault_state` has `CHECK (id = 1)` enforcing single row
- [ ] `vault_state` added to `check-rls-coverage.ts` allow-list
- [ ] `vault_state` migration created as `0002_vault_state.sql` (NOT editing drizzle-generated `0000_*`)
- [ ] Vault guard allowlist covers exactly: `GET /health`, `GET /ready`, `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`
- [ ] `vaultGuardPlugin` NOT registered when `options.vaultGuardEnabled !== true` (protects `generate-spec.ts`)
- [ ] `POST /vault/init` and `POST /vault/unseal` added to `route-audit.test.ts` exempt list
- [ ] `DATABASE_URL` superuser guard rejects `postgres` username at startup
- [ ] `VAULT_KEY_DIR` env var defined with default `'/run/secrets'`; `readKeyFile()` uses it for path confinement
- [ ] Vault init/unseal route handlers emit structured `req.log.info/warn` with `event` field on success and failure; `masterKeyPath` is never logged
- [ ] Integration test saves and restores `VAULT_KEY_DIR` env var in `afterAll()` to prevent worker contamination
- [ ] Integration test sets `VAULT_KEY_DIR` to the `tmpDir` path so key file reads are within the allowed directory
- [ ] HKDF_INFO constants exported from `kdf.ts` and used everywhere — never hardcoded info strings
- [ ] Integration test uses `writeFileSync(path, randomBytes(32))` (exactly 32 bytes, no newline)
- [ ] `GET /health` returns 200 regardless of vault state; only `GET /ready` reflects vault state
- [ ] RS256 key pair NOT generated in this story — HMAC-SHA256 is the architecture-authoritative JWT signing method

### File List
