import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Dynamic imports (not hoisted) so VAULT_KEY_DIR/VAULT_ALLOW_REMOTE_INIT are set before
// config/env.ts (a module-level singleton) reads process.env on first import — same pattern as
// vault-lifecycle.test.ts/backup-key.test.ts.
const keyDir = mkdtempSync(join(tmpdir(), 'vault-platform-audit-key-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const {
  initVault,
  zeroKeys,
  loadInitialVaultState,
  getPlatformAuditKey,
  __getRawPlatformAuditKeyForTest,
  VaultSealedError,
} = await import('./key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')

const TEST_PASSPHRASE = 'test-passphrase-12chars'

afterAll(async () => {
  await resetVaultForTest()
  rmSync(keyDir, { recursive: true, force: true })
})

describe.sequential('Story 9.4 D3/AC-4: getPlatformAuditKey()', () => {
  it('throws a VaultSealedError while the vault is sealed/uninitialized', async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()

    let caught: unknown
    try {
      getPlatformAuditKey()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(VaultSealedError)
    expect((caught as Error).message).toMatch(/platform audit key unavailable/)
  })

  it('returns a 32-byte Buffer derived via HKDF_INFO.PLATFORM_AUDIT after init', async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})

    const key = getPlatformAuditKey()
    expect(key).toBeInstanceOf(Buffer)
    expect(key).toHaveLength(32)
  })

  it('returns a fresh copy each call (mutating one does not affect the next)', async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})

    const first = getPlatformAuditKey()
    first.fill(0)
    const second = getPlatformAuditKey()
    expect(second.every((byte) => byte === 0)).toBe(false)
  })

  it('zeroKeys() zeros the in-memory platform audit key buffer', async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})

    const raw = __getRawPlatformAuditKeyForTest()
    expect(raw).not.toBeNull()
    expect(raw?.every((byte) => byte === 0)).toBe(false)

    zeroKeys()

    expect(raw?.every((byte) => byte === 0)).toBe(true)
    expect(() => getPlatformAuditKey()).toThrow(VaultSealedError)
  })

  // AC-4 edge case: the key is stable across a reseal/unseal cycle of the same instance (ikm is
  // re-derived identically from the same passphrase/params), while the in-between sealed-state
  // call throws.
  it('is stable across a reseal/unseal cycle', async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    const before = getPlatformAuditKey()

    zeroKeys()
    expect(() => getPlatformAuditKey()).toThrow(VaultSealedError)

    await loadInitialVaultState()
    const { unsealVault } = await import('./key-service.js')
    await unsealVault({ passphrase: TEST_PASSPHRASE })
    const after = getPlatformAuditKey()

    expect(after.equals(before)).toBe(true)
  })
})
