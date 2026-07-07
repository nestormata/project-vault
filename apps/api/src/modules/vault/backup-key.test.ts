import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Dynamic imports (not hoisted) so VAULT_KEY_DIR/VAULT_ALLOW_REMOTE_INIT are set before
// config/env.ts (a module-level singleton) reads process.env on first import — same pattern as
// vault-lifecycle.test.ts.
const keyDir = mkdtempSync(join(tmpdir(), 'vault-backup-key-test-'))
process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_KEY_DIR'] = keyDir
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault, zeroKeys, loadInitialVaultState, getBackupKey, __getRawBackupKeyForTest } =
  await import('./key-service.js')
const { resetVaultForTest } = await import('../../__tests__/helpers/vault-test-cleanup.js')

const TEST_PASSPHRASE = 'test-passphrase-12chars'

afterAll(async () => {
  await resetVaultForTest()
  rmSync(keyDir, { recursive: true, force: true })
})

describe.sequential('Story 9.1 D5/AC-4: getBackupKey()', () => {
  beforeEach(async () => {
    await resetVaultForTest()
    zeroKeys()
    await loadInitialVaultState()
  })

  it('throws while the vault is sealed/uninitialized', () => {
    expect(() => getBackupKey()).toThrow('getBackupKey: vault is sealed — backup key unavailable')
  })

  it('returns a 32-byte Buffer derived via HKDF_INFO.BACKUP after init', async () => {
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    const backupKey = getBackupKey()
    expect(backupKey).toBeInstanceOf(Buffer)
    expect(backupKey.length).toBe(32)
  })

  it('returns a fresh copy each call (mutating one does not affect the next)', async () => {
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    const first = getBackupKey()
    first.fill(0)
    const second = getBackupKey()
    expect(second.every((byte) => byte === 0)).toBe(false)
  })

  it('zeroKeys() zeros the in-memory backup key buffer', async () => {
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
    const raw = __getRawBackupKeyForTest()
    expect(raw).not.toBeNull()
    expect(raw?.every((byte) => byte === 0)).toBe(false)

    zeroKeys()

    expect(raw?.every((byte) => byte === 0)).toBe(true)
    expect(() => getBackupKey()).toThrow()
  })
})
