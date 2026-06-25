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

// Three vault states (architectural invariant — do not add more):
// 'uninitialized' → no vault_state row; only POST /vault/init is allowed
// 'sealed'        → vault_state row exists; only POST /vault/unseal is allowed
// 'unsealed'      → key in memory; all endpoints available
type VaultStatus = 'uninitialized' | 'sealed' | 'unsealed'
type KmsType = 'passphrase' | 'envelope' | 'file'

let _status: VaultStatus = 'uninitialized'
let _auditKey: Buffer | null = null // separate from _activeKey in packages/crypto
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

/** Call at API startup and after any vault_state truncate — syncs _status with DB. */
export async function loadInitialVaultState(): Promise<VaultStatus> {
  try {
    const db = getDb()
    const rows = await db.select().from(vaultState).limit(1)
    _status = rows.length === 0 ? 'uninitialized' : 'sealed'
    warnIfEnvelopeMisconfigured(rows[0])
    return _status
  } catch (err) {
    process.stderr.write(
      '[vault] FATAL: cannot read vault_state — verify DATABASE_URL and that PostgreSQL is reachable.\n'
    )
    throw err // main().catch → process.exit(1)
  }
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
    throw new AppError(
      'INVALID_KEY_FILE',
      `Key file must be ${expectedMin}${expectedMax !== expectedMin ? `–${expectedMax}` : ''} bytes, got ${size}`,
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

  // O_NOFOLLOW prevents TOCTOU symlink swap between stat and read (Linux)
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

type IkmResult = { ikm: Buffer; kdfParams: KeyDerivationParams | null }

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
    if (!sentinel?.version || !sentinel.iv || !sentinel.ciphertext || !sentinel.tag) {
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
  kdfParams: KeyDerivationParams | null
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
  // file mode
  if (!body.masterKeyPath) {
    throw new AppError('INVALID_KEY_FILE', 'masterKeyPath is required for file mode unseal', 400)
  }
  return readKeyFile(body.masterKeyPath)
}

export async function initVault(
  body: VaultInitRequest,
  headers: Record<string, string | string[] | undefined>
): Promise<{ initialized: true; keyVersion: number; kmsType: KmsType }> {
  assertBootstrapAuthorized(headers)

  const db = getDb()
  const { ikm, kdfParams } = await deriveIkmForInit(body)

  const primaryKey = deriveKey(ikm, HKDF_INFO.PRIMARY)
  const auditKey = deriveKey(ikm, HKDF_INFO.AUDIT_LOG)
  ikm.fill(0)

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
    })
    .onConflictDoNothing()
    .returning()

  if (inserted.length === 0) {
    primaryKey.fill(0)
    auditKey.fill(0)
    throw new AppError(
      'ALREADY_INITIALIZED',
      'Vault is already initialized. Use POST /api/v1/vault/unseal to unseal.',
      409
    )
  }

  setVaultKey(primaryKey)
  primaryKey.fill(0)

  if (_auditKey) _auditKey.fill(0)
  _auditKey = auditKey

  _status = 'unsealed'
  await notifyUnsealed()
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

  const ikm = await deriveIkmForUnseal(state.kmsType, body, kdfParams)

  const primaryKey = deriveKey(ikm, HKDF_INFO.PRIMARY)
  const auditKey = deriveKey(ikm, HKDF_INFO.AUDIT_LOG)
  ikm.fill(0)

  let sentinelDecrypted: Buffer
  try {
    sentinelDecrypted = await bootstrapDecrypt(storedSentinel, primaryKey)
  } catch {
    primaryKey.fill(0)
    auditKey.fill(0)
    throw new AppError(
      'UNSEAL_FAILED',
      'Vault unseal failed: credentials do not match stored vault configuration.',
      401
    )
  }

  const expectedSentinel = Buffer.from(SENTINEL_PLAINTEXT, 'utf8')
  if (!sentinelDecrypted.equals(expectedSentinel)) {
    primaryKey.fill(0)
    auditKey.fill(0)
    sentinelDecrypted.fill(0)
    throw new AppError('UNSEAL_FAILED', 'Vault unseal failed: sentinel mismatch.', 401)
  }
  sentinelDecrypted.fill(0)
  expectedSentinel.fill(0)

  setVaultKey(primaryKey)
  primaryKey.fill(0)

  if (_auditKey) _auditKey.fill(0)
  _auditKey = auditKey

  _status = 'unsealed'
  await notifyUnsealed()
  return { unsealed: true, keyVersion: state.keyVersion, kmsType: state.kmsType as KmsType }
}

/** Returns a copy of the audit log encryption key. Throws if vault is sealed. */
export function getAuditKey(): Buffer {
  if (!_auditKey || _status !== 'unsealed') {
    throw new Error('getAuditKey: vault is sealed — audit key unavailable')
  }
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
