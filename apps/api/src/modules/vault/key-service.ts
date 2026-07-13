import { lstatSync, openSync, readSync, closeSync, constants, type Stats } from 'node:fs'
import { resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { getDb } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'
import {
  encrypt,
  deriveKey,
  HKDF_INFO,
  setVaultKey,
  clearVaultKey,
  bootstrapDecrypt,
  deriveIkmFromPassphrase,
  createKeyDerivationParams,
  validateKeyDerivationParams,
  combineEnvelopeHalves,
  parseEnvelopeEnvHalf,
} from '@project-vault/crypto'
import type { EncryptedValue, KeyDerivationParams } from '@project-vault/crypto'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import type { VaultInitRequest, VaultUnsealRequest } from './schema.js'
import { AwsKmsProvider, KmsProviderError, type KmsKeyProvider } from './kms-provider.js'

// Three vault states (architectural invariant — do not add more):
// 'uninitialized' → no vault_state row; only POST /vault/init is allowed
// 'sealed'        → vault_state row exists; only POST /vault/unseal is allowed
// 'unsealed'      → key in memory; all endpoints available
type VaultStatus = 'uninitialized' | 'sealed' | 'unsealed'
type KmsType = 'passphrase' | 'envelope' | 'file' | 'kms'

let _status: VaultStatus = 'uninitialized'
let _primaryKey: Buffer | null = null // copy retained for encryption operations while unsealed
let _auditKey: Buffer | null = null // separate from _activeKey in packages/crypto
// Story 9.1 D5: derived at the same unseal/init moment as _auditKey — the raw IKM is zeroed
// immediately after, so a backup key cannot be derived later from anything but this copy.
let _backupKey: Buffer | null = null
// Story 9.4 D3: separate signing key for platform_audit_events — derived alongside
// _auditKey/_backupKey at the same unseal/init moment, own independent rotation lifecycle
// (vault_state.platform_audit_key_version).
let _platformAuditKey: Buffer | null = null
let _onUnsealed: (() => Promise<void>) | null = null

const SENTINEL_PLAINTEXT = 'project-vault-sentinel-v1'
const MAX_KEY_FILE_BYTES = 4096 // no legitimate key file needs more than this
const ENVELOPE_HALF_BYTES = 16

export function getVaultStatus(): VaultStatus {
  return _status
}
export function isSealed(): boolean {
  return _status !== 'unsealed'
}

export function setOnVaultUnsealed(fn: () => Promise<void>): void {
  _onUnsealed = fn
}

async function notifyUnsealed(): Promise<void> {
  await _onUnsealed?.()
}

function warnIfEnvelopeMisconfigured(row: { kmsType: string } | undefined): void {
  if (row?.kmsType !== 'envelope') return
  if (process.env['VAULT_ENVELOPE_KEY_HALF']) return
  process.stderr.write(
    '[vault] WARN: vault is sealed (envelope mode) but VAULT_ENVELOPE_KEY_HALF is not configured — unseal will fail until set\n'
  )
}

function setPrimaryKeyCopy(primaryKey: Buffer): void {
  if (_primaryKey) _primaryKey.fill(0)
  _primaryKey = Buffer.from(primaryKey)
}

/**
 * Call at API startup and after any vault_state truncate — syncs _status with DB. Any error
 * here propagates to the caller uncaught; main().catch() handles it with process.exit(1).
 */
export async function loadInitialVaultState(): Promise<VaultStatus> {
  const db = getDb()
  const rows = await db.select().from(vaultState).limit(1)
  _status = rows.length === 0 ? 'uninitialized' : 'sealed'
  warnIfEnvelopeMisconfigured(rows[0])
  return _status
}

/**
 * Read a key-material file from VAULT_KEY_DIR with hardening against symlinks and non-regular files.
 * Uses lstatSync (no follow) then openSync with O_NOFOLLOW where supported.
 */
function assertWithinKeyDir(resolved: string): void {
  const allowedDir = resolve(env.VAULT_KEY_DIR)
  if (!resolved.startsWith(allowedDir + '/') && resolved !== allowedDir) {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }
}

function statRegularFile(resolved: string): Stats {
  let stat: Stats
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved path is constrained to VAULT_KEY_DIR before file access.
    stat = lstatSync(resolved) // lstat — do NOT follow symlinks
  } catch {
    throw new AppError('KEY_FILE_NOT_FOUND', 'Cannot read key file at path: <redacted>', 400)
  }
  // Reject symlinks, directories, FIFOs, devices — only regular files
  if (!stat.isFile()) {
    throw new AppError(
      'INVALID_KEY_FILE',
      'Key path must be a regular file, not a symlink or special file',
      400
    )
  }
  return stat
}

function assertExpectedSize(
  size: number,
  expectedBytes: number | { min: number; max: number }
): void {
  if (size > MAX_KEY_FILE_BYTES) {
    throw new AppError(
      'INVALID_KEY_FILE',
      `Key file exceeds maximum allowed size (${MAX_KEY_FILE_BYTES} bytes)`,
      400
    )
  }
  const expectedMin = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes.min
  const expectedMax = typeof expectedBytes === 'number' ? expectedBytes : expectedBytes.max
  if (size < expectedMin || size > expectedMax) {
    const rangeSuffix = expectedMax !== expectedMin ? `–${expectedMax}` : ''
    throw new AppError(
      'INVALID_KEY_FILE',
      `Key file must be ${expectedMin}${rangeSuffix} bytes, got ${size}`,
      400
    )
  }
}

function readKeyMaterialFile(
  filePath: string,
  expectedBytes: number | { min: number; max: number }
): Buffer {
  const resolved = resolve(filePath)
  assertWithinKeyDir(resolved)
  const stat = statRegularFile(resolved)
  assertExpectedSize(stat.size, expectedBytes)

  // O_NOFOLLOW prevents an attacker from swapping the file for a symlink between stat and
  // read (Linux). It does NOT prevent a regular-file content swap in that same window —
  // production deployments mitigate that via read-only secrets mounts (see Dev Notes).
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated regular file inside VAULT_KEY_DIR; O_NOFOLLOW hardens the open.
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buf = Buffer.alloc(stat.size)
    readSync(fd, buf, 0, stat.size, 0)
    return buf
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

// Read live from process.env (not the cached `env` singleton) for these three fields:
// they are operational toggles operators may set between init and unseal, and integration
// tests exercise multiple configurations within a single process/module instance.
function getEnvelopeEnvHalf(): Buffer {
  const raw = process.env['VAULT_ENVELOPE_KEY_HALF']
  if (!raw) {
    throw new AppError(
      'ENVELOPE_ENV_HALF_MISSING',
      'VAULT_ENVELOPE_KEY_HALF is not configured',
      503
    )
  }
  return parseEnvelopeEnvHalf(raw)
}

function assertBootstrapAuthorized(headers: Record<string, string | string[] | undefined>): void {
  if (process.env['VAULT_ALLOW_REMOTE_INIT'] === 'true') return
  const token = process.env['VAULT_BOOTSTRAP_TOKEN']
  if (!token) {
    throw new AppError(
      'BOOTSTRAP_FORBIDDEN',
      'Vault bootstrap requires valid bootstrap credentials',
      403
    )
  }
  const header = headers['x-vault-bootstrap-token']
  const supplied = Array.isArray(header) ? header[0] : header
  if (
    !supplied ||
    supplied.length !== token.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  ) {
    throw new AppError(
      'BOOTSTRAP_FORBIDDEN',
      'Vault bootstrap requires valid bootstrap credentials',
      403
    )
  }
}

type IkmResult = {
  ikm: Buffer
  kdfParams: KeyDerivationParams | null
  kmsKeyId?: string
  kmsEncryptedDek?: string
}

// Story 1.14 AC-21: module-level singleton, lazily constructed so no AWS SDK client is ever
// instantiated for non-kms deployments. `__setKmsProviderForTest` (below) lets tests inject a
// fake KmsKeyProvider without touching AWS at all — mirrors this module's existing test-only
// escape hatches (`__getRawBackupKeyForTest`, etc.).
let _kmsProvider: KmsKeyProvider | null = null

function getKmsProvider(): KmsKeyProvider {
  _kmsProvider ??= new AwsKmsProvider()
  return _kmsProvider
}

/** Test-only: overrides (or, passed `null`, clears) the module-level KmsKeyProvider singleton.
 * Never use outside tests — production always resolves the real AwsKmsProvider lazily. */
export function __setKmsProviderForTest(provider: KmsKeyProvider | null): void {
  _kmsProvider = provider
}

/** Story 1.14 AC-3/AC-4/AC-5: maps a KmsProviderError's provider-agnostic `kind` to the
 * init-specific AppError/status code. A non-KmsProviderError (should not happen — AwsKmsProvider
 * always wraps) is rethrown as-is rather than swallowed. */
function mapKmsErrorForInit(error: unknown): never {
  if (!(error instanceof KmsProviderError)) throw error
  switch (error.kind) {
    case 'not_found':
      throw new AppError(
        'KMS_KEY_NOT_FOUND',
        'The specified KMS key was not found. Verify kmsKeyId and that the key exists in the configured AWS region.',
        400
      )
    case 'permission_denied':
      throw new AppError(
        'KMS_PERMISSION_DENIED',
        "The API's AWS credentials do not have permission to use the configured KMS key. Verify the IAM policy grants kms:GenerateDataKey and kms:Decrypt on this key.",
        403
      )
    case 'unreachable':
    case 'unknown':
    default:
      throw new AppError(
        'KMS_UNREACHABLE',
        'Could not reach the configured KMS provider. Verify network connectivity and KMS endpoint configuration.',
        503
      )
  }
}

/** Story 1.14 AC-11/AC-12/AC-13: maps a KmsProviderError's `kind` to the unseal-specific
 * AppError/status code — deliberately different from `mapKmsErrorForInit` for the `not_found`
 * case (AC-12's `kms_key_unavailable`/503 vs. AC-4's `kms_key_not_found`/400), since the same
 * underlying AWS exception class means something different depending on when it happens: at
 * init, the key was simply never usable to begin with; at unseal, a previously-working key has
 * become unusable, which is the KMS-mode equivalent of losing a `file`-mode key file. */
function mapKmsErrorForUnseal(error: unknown): never {
  if (!(error instanceof KmsProviderError)) throw error
  switch (error.kind) {
    case 'not_found':
      throw new AppError(
        'KMS_KEY_UNAVAILABLE',
        "The KMS key required to unseal this vault is not currently usable (deleted, disabled, or pending deletion). This is a permanent data-loss risk if the key cannot be restored — see the runbook's KMS key-loss procedure.",
        503
      )
    case 'permission_denied':
      throw new AppError(
        'KMS_PERMISSION_DENIED',
        "The API's AWS credentials do not have permission to decrypt the vault's KMS-wrapped key. Verify the IAM policy grants kms:Decrypt on this key.",
        403
      )
    case 'unreachable':
    case 'unknown':
    default:
      throw new AppError(
        'KMS_UNREACHABLE',
        'Could not reach the configured KMS provider. The vault remains sealed. Verify network connectivity and retry.',
        503
      )
  }
}

async function deriveIkmForInit(body: VaultInitRequest): Promise<IkmResult> {
  if (body.kmsType === 'passphrase') {
    const params = createKeyDerivationParams()
    const ikm = await deriveIkmFromPassphrase(body.passphrase, params)
    return { ikm, kdfParams: params }
  }
  if (body.kmsType === 'envelope') {
    const envHalf = getEnvelopeEnvHalf()
    const fileHalf = readEnvelopeFileHalf(body.envelopeKeyPath)
    const ikm = combineEnvelopeHalves(envHalf, fileHalf)
    envHalf.fill(0)
    fileHalf.fill(0)
    return { ikm, kdfParams: null }
  }
  if (body.kmsType === 'kms') {
    try {
      const { plaintext, ciphertextBlob } = await getKmsProvider().generateDataKey(body.kmsKeyId)
      return {
        ikm: plaintext,
        kdfParams: null,
        kmsKeyId: body.kmsKeyId,
        kmsEncryptedDek: ciphertextBlob,
      }
    } catch (error) {
      mapKmsErrorForInit(error)
    }
  }
  // file mode
  const ikm = readKeyFile(body.masterKeyPath)
  return { ikm, kdfParams: null }
}

function parseVaultStateRow(state: {
  encryptedSentinel: string
  keyDerivationParams: string | null
  kmsType: string
}): { sentinel: EncryptedValue; kdfParams: KeyDerivationParams | null } {
  try {
    const sentinel = JSON.parse(state.encryptedSentinel) as EncryptedValue
    if (
      typeof sentinel?.version !== 'number' ||
      !sentinel.iv ||
      !sentinel.ciphertext ||
      !sentinel.tag
    ) {
      throw new Error('invalid EncryptedValue shape')
    }
    let kdfParams: KeyDerivationParams | null = null
    if (state.kmsType === 'passphrase') {
      kdfParams = JSON.parse(state.keyDerivationParams ?? '') as KeyDerivationParams
      validateKeyDerivationParams(kdfParams)
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

async function deriveIkmForUnseal(
  kmsType: string,
  body: VaultUnsealRequest,
  kdfParams: KeyDerivationParams | null,
  kmsEncryptedDek: string | null
): Promise<Buffer> {
  if (kmsType === 'passphrase') {
    if (!body.passphrase) {
      throw new AppError('INVALID_PASSPHRASE', 'Passphrase must be at least 12 characters', 400)
    }
    return deriveIkmFromPassphrase(body.passphrase, kdfParams as KeyDerivationParams)
  }
  if (kmsType === 'envelope') {
    if (!body.envelopeKeyPath) {
      throw new AppError(
        'INVALID_KEY_FILE',
        'envelopeKeyPath is required for envelope mode unseal',
        400
      )
    }
    const envHalf = getEnvelopeEnvHalf()
    const fileHalf = readEnvelopeFileHalf(body.envelopeKeyPath)
    const ikm = combineEnvelopeHalves(envHalf, fileHalf)
    envHalf.fill(0)
    fileHalf.fill(0)
    return ikm
  }
  if (kmsType === 'kms') {
    // AC-7's deferred DB-level CHECK means a NULL kms_encrypted_dek is theoretically reachable
    // (migration bug, manual DB edit, admin script) even though the application code path never
    // produces it — fail cleanly with the same VAULT_CORRUPTED class used for other tampered/
    // malformed vault_state shapes, rather than crashing deeper in the KMS provider call.
    if (!kmsEncryptedDek) {
      throw new AppError(
        'VAULT_CORRUPTED',
        'vault_state data is corrupt or tampered — restore from backup or re-initialize',
        503
      )
    }
    // Extraneous legacy fields (body.passphrase/envelopeKeyPath/masterKeyPath) are never read
    // here — AC-10's "silently ignored, not an error" requirement is satisfied by construction.
    try {
      return await getKmsProvider().decryptDataKey(kmsEncryptedDek)
    } catch (error) {
      mapKmsErrorForUnseal(error)
    }
  }
  // file mode
  if (!body.masterKeyPath) {
    throw new AppError('INVALID_KEY_FILE', 'masterKeyPath is required for file mode unseal', 400)
  }
  return readKeyFile(body.masterKeyPath)
}

/** Shared by `initVault`/`unsealVault`: derives all four keys from the same IKM and zeroes the
 * IKM immediately after — identical in both callers, only the IKM's own derivation differs
 * (passphrase/envelope/file mode vs. re-deriving from stored KDF params). */
function deriveAllKeysFromIkm(ikm: Buffer): {
  primaryKey: Buffer
  auditKey: Buffer
  backupKey: Buffer
  platformAuditKey: Buffer
} {
  const primaryKey = deriveKey(ikm, HKDF_INFO.PRIMARY)
  const auditKey = deriveKey(ikm, HKDF_INFO.AUDIT_LOG)
  const backupKey = deriveKey(ikm, HKDF_INFO.BACKUP)
  const platformAuditKey = deriveKey(ikm, HKDF_INFO.PLATFORM_AUDIT)
  ikm.fill(0)
  return { primaryKey, auditKey, backupKey, platformAuditKey }
}

/** Shared by every init/unseal failure path that needs to discard freshly-derived secondary keys
 * before throwing — `primaryKey` is handled separately at each call site since not every failure
 * path has claimed it yet (Story 9.1/9.4: audit/backup/platform-audit keys, always derived and
 * discarded together). */
function zeroSecondaryKeys(auditKey: Buffer, backupKey: Buffer, platformAuditKey: Buffer): void {
  auditKey.fill(0)
  backupKey.fill(0)
  platformAuditKey.fill(0)
}

/** Shared by `initVault`/`unsealVault`'s final step: commits the freshly-derived keys as the new
 * module-level state, zeroing whatever was cached before (a no-op on first init, real cleanup on
 * every subsequent unseal), then flips `_status` to `'unsealed'` and fires the post-unseal hook. */
async function commitUnsealedKeys(keys: {
  primaryKey: Buffer
  auditKey: Buffer
  backupKey: Buffer
  platformAuditKey: Buffer
}): Promise<void> {
  setVaultKey(keys.primaryKey)
  setPrimaryKeyCopy(keys.primaryKey)
  keys.primaryKey.fill(0)

  if (_auditKey) _auditKey.fill(0)
  _auditKey = keys.auditKey

  if (_backupKey) _backupKey.fill(0)
  _backupKey = keys.backupKey

  if (_platformAuditKey) _platformAuditKey.fill(0)
  _platformAuditKey = keys.platformAuditKey

  _status = 'unsealed'
  await notifyUnsealed()
}

export async function initVault(
  body: VaultInitRequest,
  headers: Record<string, string | string[] | undefined>
): Promise<{ initialized: true; keyVersion: number; kmsType: KmsType }> {
  assertBootstrapAuthorized(headers)

  const db = getDb()
  const ikmResult = await deriveIkmForInit(body)
  const { ikm, kdfParams } = ikmResult
  const { primaryKey, auditKey, backupKey, platformAuditKey } = deriveAllKeysFromIkm(ikm)

  const sentinel = Buffer.from(SENTINEL_PLAINTEXT, 'utf8')
  const encryptedSentinel: EncryptedValue = await encrypt(sentinel, primaryKey)
  sentinel.fill(0)

  // INSERT ON CONFLICT DO NOTHING: atomic check-then-insert eliminates TOCTOU race.
  const inserted = await db
    .insert(vaultState)
    .values({
      id: 1,
      keyVersion: 1,
      auditKeyVersion: 1,
      encryptedSentinel: JSON.stringify(encryptedSentinel),
      kmsType: body.kmsType,
      keyDerivationParams: kdfParams ? JSON.stringify(kdfParams) : null,
      kmsKeyId: ikmResult.kmsKeyId ?? null,
      kmsEncryptedDek: ikmResult.kmsEncryptedDek ?? null,
    })
    .onConflictDoNothing()
    .returning()

  if (inserted.length === 0) {
    primaryKey.fill(0)
    zeroSecondaryKeys(auditKey, backupKey, platformAuditKey)
    throw new AppError(
      'ALREADY_INITIALIZED',
      'Vault is already initialized. Use POST /api/v1/vault/unseal to unseal.',
      409
    )
  }

  await commitUnsealedKeys({ primaryKey, auditKey, backupKey, platformAuditKey })
  return { initialized: true, keyVersion: 1, kmsType: body.kmsType }
}

export async function unsealVault(
  body: VaultUnsealRequest
): Promise<{ unsealed: true; keyVersion: number; kmsType: KmsType }> {
  if (_status === 'unsealed') {
    throw new AppError('ALREADY_UNSEALED', 'Vault is already unsealed.', 400)
  }

  const db = getDb()
  const rows = await db.select().from(vaultState).limit(1)
  const state = rows[0]
  if (!state) {
    throw new AppError(
      'NOT_INITIALIZED',
      'Vault has not been initialized. Use POST /api/v1/vault/init first.',
      400
    )
  }
  const { sentinel: storedSentinel, kdfParams } = parseVaultStateRow(state)

  const ikm = await deriveIkmForUnseal(state.kmsType, body, kdfParams, state.kmsEncryptedDek)
  const { primaryKey, auditKey, backupKey, platformAuditKey } = deriveAllKeysFromIkm(ikm)

  let sentinelDecrypted: Buffer
  try {
    sentinelDecrypted = await bootstrapDecrypt(storedSentinel, primaryKey)
  } catch {
    primaryKey.fill(0)
    zeroSecondaryKeys(auditKey, backupKey, platformAuditKey)
    throw new AppError(
      'UNSEAL_FAILED',
      'Vault unseal failed: credentials do not match stored vault configuration.',
      401
    )
  }

  const expectedSentinel = Buffer.from(SENTINEL_PLAINTEXT, 'utf8')
  if (!sentinelDecrypted.equals(expectedSentinel)) {
    primaryKey.fill(0)
    zeroSecondaryKeys(auditKey, backupKey, platformAuditKey)
    sentinelDecrypted.fill(0)
    throw new AppError('UNSEAL_FAILED', 'Vault unseal failed: sentinel mismatch.', 401)
  }
  sentinelDecrypted.fill(0)
  expectedSentinel.fill(0)

  await commitUnsealedKeys({ primaryKey, auditKey, backupKey, platformAuditKey })
  return { unsealed: true, keyVersion: state.keyVersion, kmsType: state.kmsType as KmsType }
}

/** Thrown by `getAuditKey()`/`getPrimaryKey()` when the vault is sealed or uninitialized. A typed
 * class (rather than a plain `Error` matched by callers on its `.message` text) lets callers use
 * `instanceof VaultSealedError` — so the check can't silently break if the message text is ever
 * edited in this file without a corresponding change at the call site (code review finding,
 * Story 8.1: `apps/api/src/modules/audit/routes.ts` originally matched a duplicated string
 * literal). */
export class VaultSealedError extends Error {}

/** Returns a copy of the audit log encryption key. Throws if vault is sealed. */
export function getAuditKey(): Buffer {
  if (!_auditKey || _status !== 'unsealed') {
    throw new VaultSealedError('getAuditKey: vault is sealed — audit key unavailable')
  }
  return Buffer.from(_auditKey)
}

/** Returns a copy of the primary encryption key. Throws if vault is sealed. */
export function getPrimaryKey(): Buffer {
  if (!_primaryKey || _status !== 'unsealed') {
    throw new Error('getPrimaryKey: vault is sealed — primary key unavailable')
  }
  return Buffer.from(_primaryKey)
}

/** Story 9.1 D5/AC-4: returns a copy of the backup encryption key (derived via
 * `deriveKey(ikm, HKDF_INFO.BACKUP)` at the same unseal/init moment as the audit key). Mirrors
 * `getAuditKey()`'s exact contract — throws a `VaultSealedError` if the vault is sealed. */
export function getBackupKey(): Buffer {
  if (!_backupKey || _status !== 'unsealed') {
    throw new VaultSealedError('getBackupKey: vault is sealed — backup key unavailable')
  }
  return Buffer.from(_backupKey)
}

/** Test-only: exposes the raw backup-key buffer reference (not a copy) so a test can verify
 * `zeroKeys()` actually mutates the in-memory buffer in place, rather than just discarding the
 * reference. Never use outside tests — production code must always use `getBackupKey()`. */
export function __getRawBackupKeyForTest(): Buffer | null {
  return _backupKey
}

/** Story 9.4 D3/AC-4: returns a copy of the platform audit log signing key (derived via
 * `deriveKey(ikm, HKDF_INFO.PLATFORM_AUDIT)` at the same unseal/init moment as the other keys).
 * Mirrors `getAuditKey()`'s exact contract — throws a `VaultSealedError` if the vault is sealed. */
export function getPlatformAuditKey(): Buffer {
  if (!_platformAuditKey || _status !== 'unsealed') {
    throw new VaultSealedError(
      'getPlatformAuditKey: vault is sealed — platform audit key unavailable'
    )
  }
  return Buffer.from(_platformAuditKey)
}

/** Test-only: exposes the raw platform-audit-key buffer reference (not a copy) so a test can
 * verify `zeroKeys()` actually mutates the in-memory buffer in place. Never use outside tests. */
export function __getRawPlatformAuditKeyForTest(): Buffer | null {
  return _platformAuditKey
}

/** Called by shutdown.ts to zero in-memory keys before process exit. */
export function zeroKeys(): void {
  clearVaultKey()
  if (_primaryKey) {
    _primaryKey.fill(0)
    _primaryKey = null
  }
  if (_auditKey) {
    _auditKey.fill(0)
    _auditKey = null
  }
  if (_backupKey) {
    _backupKey.fill(0)
    _backupKey = null
  }
  if (_platformAuditKey) {
    _platformAuditKey.fill(0)
    _platformAuditKey = null
  }
  _status = 'sealed'
}
