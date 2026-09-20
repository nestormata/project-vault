/* eslint-disable security/detect-non-literal-fs-filename -- test fixtures intentionally exercise dynamic temp-file key paths. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { encrypt, deriveKey, HKDF_INFO, createKeyDerivationParams } from '@project-vault/crypto'

const limit = vi.fn()
const db = {
  select: vi.fn(() => ({
    from: () => ({
      limit,
    }),
  })),
}

vi.mock('@project-vault/db', () => ({
  getDb: () => db,
}))

// vi.hoisted: the vi.mock factory below is hoisted above this file's imports, so the mutable
// object it closes over must be created via vi.hoisted() rather than a plain top-level `const` —
// otherwise the factory would reference a not-yet-initialized binding. Story 42.4 Task 2: tests
// mutate envState.VAULT_KEY_DIR to a fresh fs.mkdtemp()-style unique temp dir per test (Pre-mortem
// Analysis finding — a shared fixed path would be a real, if narrow, source of CI flakiness under
// Vitest's parallel workers).
const envState = vi.hoisted(() => ({ VAULT_KEY_DIR: '/run/secrets' }))

vi.mock('../../config/env.js', () => ({
  env: envState,
}))

describe('loadInitialVaultState', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not write raw stderr when vault state cannot be loaded', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    limit.mockRejectedValueOnce(new Error('database unavailable'))
    const { loadInitialVaultState } = await import('./key-service.js')

    await expect(loadInitialVaultState()).rejects.toThrow('database unavailable')

    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})

describe('getAuditKey', () => {
  // Adversarial-review finding (Story 8.1 code review): apps/api/src/modules/audit/routes.ts
  // originally detected a sealed vault by matching getAuditKey()'s thrown Error#message against a
  // hardcoded string literal duplicated in that file. If this message text ever drifted, the
  // match would silently fail and AC-10's required `503 audit_key_unavailable` would degrade to
  // an unhandled 500 with no compiler/test signal at the drift site. A typed error class removes
  // that duplication — callers match by `instanceof`, not by re-typing the message elsewhere.
  it('throws a VaultSealedError instance (not a bare Error) when the vault is sealed/uninitialized', async () => {
    const { getAuditKey, VaultSealedError } = await import('./key-service.js')

    let caught: unknown
    try {
      getAuditKey()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(VaultSealedError)
  })
})

// ---------------------------------------------------------------------------------------------
// Story 42.4: crash/partial-write coverage for key-service.ts's file-mode and envelope-mode
// key-material paths, and for the DB-row corruption branches of parseVaultStateRow/
// deriveIkmForUnseal. Everything below drives readKeyFile/readEnvelopeFileHalf indirectly through
// unsealVault() (their only production call site exercised here — deriveIkmForInit shares the
// exact same readKeyFile/readEnvelopeFileHalf functions, so covering the unseal path fully
// exercises the shared implementation without also having to satisfy initVault's bootstrap-token
// gate in every test).
// ---------------------------------------------------------------------------------------------

// Matches key-service.ts's private SENTINEL_PLAINTEXT constant exactly — not exported, so pinned
// here by literal value. A real drift of this constant would break every existing unseal in
// production, not just this test, so pinning it is intentional white-box coverage, not a
// maintenance trap.
const SENTINEL_PLAINTEXT = 'project-vault-sentinel-v1'
const MAX_KEY_FILE_BYTES = 4096

function fileModeState(encryptedSentinel: string): {
  encryptedSentinel: string
  keyDerivationParams: string | null
  kmsType: string
  keyVersion: number
  kmsEncryptedDek: string | null
} {
  return {
    encryptedSentinel,
    keyDerivationParams: null,
    kmsType: 'file',
    keyVersion: 1,
    kmsEncryptedDek: null,
  }
}

async function encryptedSentinelFor(ikm: Buffer): Promise<string> {
  const primaryKey = deriveKey(ikm, HKDF_INFO.PRIMARY)
  const encrypted = await encrypt(Buffer.from(SENTINEL_PLAINTEXT, 'utf8'), primaryKey)
  return JSON.stringify(encrypted)
}

describe('unsealVault: file-mode key material — crash/partial-write coverage (AC1, AC3, AC4)', () => {
  let keyDir: string

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'key-service-file-mode-'))
    envState.VAULT_KEY_DIR = keyDir
  })

  afterEach(async () => {
    rmSync(keyDir, { recursive: true, force: true })
    vi.clearAllMocks()
    const { zeroKeys } = await import('./key-service.js')
    zeroKeys()
  })

  it('positive: a well-formed 32-byte key file is accepted and unsealVault proceeds to derive/commit keys', async () => {
    const keyBytes = randomBytes(32)
    const keyPath = join(keyDir, 'master.key')
    writeFileSync(keyPath, keyBytes)
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(keyBytes))])

    const { unsealVault, isSealed, getPrimaryKey } = await import('./key-service.js')

    const result = await unsealVault({ masterKeyPath: keyPath })

    expect(result).toMatchObject({ unsealed: true, kmsType: 'file' })
    expect(isSealed()).toBe(false)
    expect(getPrimaryKey()).toHaveLength(32)
  })

  it('positive boundary (5-round elicitation, Boundary & Edge Case Sweep): a key file of exactly MAX_KEY_FILE_BYTES (4096) bytes is accepted', async () => {
    const keyBytes = randomBytes(MAX_KEY_FILE_BYTES)
    const keyPath = join(keyDir, 'master-max.key')
    writeFileSync(keyPath, keyBytes)
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(keyBytes))])

    const { unsealVault, isSealed } = await import('./key-service.js')

    const result = await unsealVault({ masterKeyPath: keyPath })

    expect(result).toMatchObject({ unsealed: true, kmsType: 'file' })
    expect(isSealed()).toBe(false)
  })

  it('negative: a key file truncated below 32 bytes (simulating a crash mid-write(2)) throws INVALID_KEY_FILE before any key is derived', async () => {
    const truncatedBytes = randomBytes(10)
    const keyPath = join(keyDir, 'truncated.key')
    writeFileSync(keyPath, truncatedBytes)
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(randomBytes(32)))])

    const { unsealVault, isSealed } = await import('./key-service.js')

    let caught: unknown
    try {
      await unsealVault({ masterKeyPath: keyPath })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: 'INVALID_KEY_FILE',
      statusCode: 400,
      message: expect.stringContaining('32'),
    })
    // Security assertion (5-round elicitation, Security Audit Personas): the error message names
    // only metadata about the bad key material (its length), never the raw bytes read from disk.
    expect((caught as Error).message).not.toContain(truncatedBytes.toString('hex'))
    // The vault must never have been unsealed from partial key material — the error is thrown
    // inside deriveIkmForUnseal, strictly before deriveAllKeysFromIkm is ever reached.
    expect(isSealed()).toBe(true)
  })

  it('negative: a key file exceeding MAX_KEY_FILE_BYTES (4096) throws INVALID_KEY_FILE with an exceeds-maximum message', async () => {
    const oversizedBytes = randomBytes(MAX_KEY_FILE_BYTES + 1)
    const keyPath = join(keyDir, 'oversized.key')
    writeFileSync(keyPath, oversizedBytes)
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(randomBytes(32)))])

    const { unsealVault } = await import('./key-service.js')

    await expect(unsealVault({ masterKeyPath: keyPath })).rejects.toMatchObject({
      code: 'INVALID_KEY_FILE',
      statusCode: 400,
      message: expect.stringContaining('maximum'),
    })
  })

  it('negative: a symlink in place of a regular key file is rejected as INVALID_KEY_FILE ("must be a regular file")', async () => {
    const targetPath = join(tmpdir(), `key-service-symlink-target-${process.pid}.bin`)
    writeFileSync(targetPath, randomBytes(32))
    const linkPath = join(keyDir, 'link.key')
    symlinkSync(targetPath, linkPath)
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(randomBytes(32)))])

    try {
      const { unsealVault } = await import('./key-service.js')

      await expect(unsealVault({ masterKeyPath: linkPath })).rejects.toMatchObject({
        code: 'INVALID_KEY_FILE',
        statusCode: 400,
        message: expect.stringContaining('regular file'),
      })
    } finally {
      rmSync(targetPath, { force: true })
    }
  })

  it('negative: a missing key file throws KEY_FILE_NOT_FOUND', async () => {
    const missingPath = join(keyDir, 'does-not-exist.key')
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(randomBytes(32)))])

    const { unsealVault } = await import('./key-service.js')

    await expect(unsealVault({ masterKeyPath: missingPath })).rejects.toMatchObject({
      code: 'KEY_FILE_NOT_FOUND',
      statusCode: 400,
    })
  })
})

describe('unsealVault: envelope-mode key material — crash/partial-write coverage (AC1, AC3, AC4)', () => {
  let keyDir: string
  const envHalfHex = randomBytes(16).toString('hex')

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'key-service-envelope-mode-'))
    envState.VAULT_KEY_DIR = keyDir
    process.env['VAULT_ENVELOPE_KEY_HALF'] = envHalfHex
  })

  afterEach(async () => {
    rmSync(keyDir, { recursive: true, force: true })
    delete process.env['VAULT_ENVELOPE_KEY_HALF']
    vi.clearAllMocks()
    const { zeroKeys } = await import('./key-service.js')
    zeroKeys()
  })

  it('positive: an exactly-16-byte file half combines with the env half and unseals successfully', async () => {
    const fileHalf = randomBytes(16)
    const halfPath = join(keyDir, 'envelope.half')
    writeFileSync(halfPath, fileHalf)
    const ikm = Buffer.concat([Buffer.from(envHalfHex, 'hex'), fileHalf])
    limit.mockResolvedValueOnce([
      { ...fileModeState(await encryptedSentinelFor(ikm)), kmsType: 'envelope' },
    ])

    const { unsealVault, isSealed } = await import('./key-service.js')

    const result = await unsealVault({ envelopeKeyPath: halfPath })

    expect(result).toMatchObject({ unsealed: true, kmsType: 'envelope' })
    expect(isSealed()).toBe(false)
  })

  it('negative: a file half truncated below 16 bytes throws INVALID_KEY_FILE via the exact-size branch of assertExpectedSize', async () => {
    const truncatedHalf = randomBytes(8)
    const halfPath = join(keyDir, 'truncated.half')
    writeFileSync(halfPath, truncatedHalf)
    limit.mockResolvedValueOnce([
      { ...fileModeState(await encryptedSentinelFor(randomBytes(32))), kmsType: 'envelope' },
    ])

    const { unsealVault } = await import('./key-service.js')

    await expect(unsealVault({ envelopeKeyPath: halfPath })).rejects.toMatchObject({
      code: 'INVALID_KEY_FILE',
      statusCode: 400,
      message: expect.stringContaining('16 bytes'),
    })
  })

  it('negative: an oversized file half (>16 bytes) throws INVALID_KEY_FILE via the exact-size branch of assertExpectedSize', async () => {
    const oversizedHalf = randomBytes(20)
    const halfPath = join(keyDir, 'oversized.half')
    writeFileSync(halfPath, oversizedHalf)
    limit.mockResolvedValueOnce([
      { ...fileModeState(await encryptedSentinelFor(randomBytes(32))), kmsType: 'envelope' },
    ])

    const { unsealVault } = await import('./key-service.js')

    await expect(unsealVault({ envelopeKeyPath: halfPath })).rejects.toMatchObject({
      code: 'INVALID_KEY_FILE',
      statusCode: 400,
      message: expect.stringContaining('16 bytes'),
    })
  })
})

describe('unsealVault: content-corruption-with-correct-size key file (hardest AC1 edge case)', () => {
  let keyDir: string

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'key-service-content-corruption-'))
    envState.VAULT_KEY_DIR = keyDir
  })

  afterEach(async () => {
    rmSync(keyDir, { recursive: true, force: true })
    vi.clearAllMocks()
    const { zeroKeys } = await import('./key-service.js')
    zeroKeys()
  })

  it('a correct-size but wrong-content key file is caught by the existing sentinel/AEAD check, not by size validation, and no key is ever committed', async () => {
    // The "real" key that produced the stored sentinel — simulates a crash that truncated an
    // in-place rewrite and left the filesystem zero-padding the tail back up to the old file's
    // length: the file is the correct size (32 bytes) but its content no longer matches what
    // produced the stored vault_state row.
    const trueKeyBytes = randomBytes(32)
    const corruptedButCorrectSizeBytes = randomBytes(32) // different content, same size
    const keyPath = join(keyDir, 'corrupted-same-size.key')
    writeFileSync(keyPath, corruptedButCorrectSizeBytes)
    limit.mockResolvedValueOnce([fileModeState(await encryptedSentinelFor(trueKeyBytes))])

    const {
      unsealVault,
      isSealed,
      getPrimaryKey,
      getAuditKey,
      __getRawBackupKeyForTest,
      __getRawPlatformAuditKeyForTest,
    } = await import('./key-service.js')

    let caught: unknown
    try {
      await unsealVault({ masterKeyPath: keyPath })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: 'UNSEAL_FAILED', statusCode: 401 })
    // Security assertion: the generic mismatch message never leaks either buffer's raw bytes.
    expect((caught as Error).message).not.toContain(corruptedButCorrectSizeBytes.toString('hex'))
    expect((caught as Error).message).not.toContain(trueKeyBytes.toString('hex'))

    // Behavioral proof (5-round elicitation, Pre-mortem Analysis): primaryKey/auditKey have no
    // raw-buffer test getters, so the reliable assertion is behavioral — the vault stays sealed
    // and both getters still throw the normal "sealed" error rather than ever returning a key
    // derived from the bad input.
    expect(isSealed()).toBe(true)
    expect(() => getPrimaryKey()).toThrow()
    expect(() => getAuditKey()).toThrow()
    // Corroborating evidence via the raw getters that do exist for backup/platform-audit keys.
    expect(__getRawBackupKeyForTest()).toBeNull()
    expect(__getRawPlatformAuditKeyForTest()).toBeNull()
  })
})

describe('deriveIkmForUnseal: unrecognized/corrupt kms_type (DB-row corruption)', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    const { zeroKeys } = await import('./key-service.js')
    zeroKeys()
  })

  it('throws VAULT_CORRUPTED (503) for an unrecognized kms_type value instead of silently falling through to file mode', async () => {
    limit.mockResolvedValueOnce([
      { ...fileModeState(await encryptedSentinelFor(randomBytes(32))), kmsType: 'bogus-mode' },
    ])

    const { unsealVault } = await import('./key-service.js')

    await expect(unsealVault({ masterKeyPath: '/does/not/matter' })).rejects.toMatchObject({
      code: 'VAULT_CORRUPTED',
      statusCode: 503,
    })
  })
})

describe('parseVaultStateRow: malformed encryptedSentinel (half-written/corrupted vault_state row)', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    const { zeroKeys } = await import('./key-service.js')
    zeroKeys()
  })

  it('throws VAULT_CORRUPTED (503), never a raw JSON.parse SyntaxError, for a malformed encryptedSentinel string', async () => {
    limit.mockResolvedValueOnce([fileModeState('not-valid-json{{{')])

    const { unsealVault } = await import('./key-service.js')

    let caught: unknown
    try {
      await unsealVault({ masterKeyPath: '/does/not/matter' })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: 'VAULT_CORRUPTED', statusCode: 503 })
    expect(caught).not.toBeInstanceOf(SyntaxError)
  })
})

// Code-review finding (Story 42.4 review pass): the malformed-encryptedSentinel test above only
// ever supplies kmsType: 'file', so parseVaultStateRow's passphrase-mode branch (JSON.parse of
// keyDerivationParams, then validateKeyDerivationParams) was never exercised by any corruption
// test despite this file's own orienting comment (line ~74) claiming coverage of
// "DB-row corruption branches of parseVaultStateRow" generally. These two tests close that gap.
describe('parseVaultStateRow: malformed keyDerivationParams (passphrase-mode DB-row corruption)', () => {
  afterEach(async () => {
    vi.clearAllMocks()
    const { zeroKeys } = await import('./key-service.js')
    zeroKeys()
  })

  it('throws VAULT_CORRUPTED (503), never a raw JSON.parse SyntaxError, for an unparseable keyDerivationParams string', async () => {
    limit.mockResolvedValueOnce([
      {
        ...fileModeState(await encryptedSentinelFor(randomBytes(32))),
        kmsType: 'passphrase',
        keyDerivationParams: 'not-valid-json{{{',
      },
    ])

    const { unsealVault } = await import('./key-service.js')

    let caught: unknown
    try {
      await unsealVault({ passphrase: 'a-passphrase-that-is-long-enough' })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: 'VAULT_CORRUPTED', statusCode: 503 })
    expect(caught).not.toBeInstanceOf(SyntaxError)
  })

  it('throws VAULT_CORRUPTED (503) for a parseable-but-invalid keyDerivationParams object (fails validateKeyDerivationParams)', async () => {
    limit.mockResolvedValueOnce([
      {
        ...fileModeState(await encryptedSentinelFor(randomBytes(32))),
        kmsType: 'passphrase',
        keyDerivationParams: JSON.stringify({ ...createKeyDerivationParams(), memoryCost: 1024 }),
      },
    ])

    const { unsealVault } = await import('./key-service.js')

    await expect(
      unsealVault({ passphrase: 'a-passphrase-that-is-long-enough' })
    ).rejects.toMatchObject({ code: 'VAULT_CORRUPTED', statusCode: 503 })
  })
})
