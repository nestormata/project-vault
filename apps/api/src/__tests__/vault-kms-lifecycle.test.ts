import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
const keyDir = mkdtempSync(join(tmpdir(), 'vault-kms-test-'))
process.env['VAULT_KEY_DIR'] = keyDir

const { createApp } = await import('../app.js')
const { initVault, unsealVault, zeroKeys, loadInitialVaultState, __setKmsProviderForTest } =
  await import('../modules/vault/key-service.js')
const { KmsProviderError } = await import('../modules/vault/kms-provider.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { getDb } = await import('@project-vault/db')
const { vaultState } = await import('@project-vault/db/schema')

const KEY_ID = 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr'
const INIT_URL = '/api/v1/vault/init'
const UNSEAL_URL = '/api/v1/vault/unseal'

/** Fake KmsKeyProvider: generateDataKey returns a fixed 32-byte plaintext + a base64 "ciphertext"
 * that is literally the plaintext hex-encoded (deterministic, reversible, test-only) — so
 * decryptDataKey can recover the identical IKM without any real AWS call, mirroring the actual
 * envelope-encryption round trip this story implements. */
function makeFakeKmsProvider() {
  const store = new Map<string, Buffer>()
  return {
    generateDataKey: vi.fn(async (keyId: string) => {
      const plaintext = Buffer.alloc(32, 7)
      const ciphertextBlob = Buffer.from(`wrapped:${keyId}`).toString('base64')
      store.set(ciphertextBlob, plaintext)
      return { plaintext: Buffer.from(plaintext), ciphertextBlob }
    }),
    decryptDataKey: vi.fn(async (ciphertextBlob: string) => {
      const plaintext = store.get(ciphertextBlob)
      if (!plaintext) throw new KmsProviderError('not_found', 'unknown ciphertext blob')
      return Buffer.from(plaintext)
    }),
  }
}

async function restartSealed(): Promise<void> {
  zeroKeys()
  await loadInitialVaultState()
}

afterAll(async () => {
  __setKmsProviderForTest(null)
  await resetVaultForTest()
  const { rmSync } = await import('node:fs')
  rmSync(keyDir, { recursive: true, force: true })
})

describe.sequential('Story 1.14: KMS unseal mode', () => {
  beforeEach(async () => {
    await resetVaultForTest()
    __setKmsProviderForTest(makeFakeKmsProvider())
  })

  it('AC-1: init with kms mode stores kms_key_id/kms_encrypted_dek and returns kmsType=kms', async () => {
    const result = await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    expect(result).toMatchObject({ initialized: true, keyVersion: 1, kmsType: 'kms' })

    const [row] = await getDb().select().from(vaultState).limit(1)
    expect(row?.kmsType).toBe('kms')
    expect(row?.kmsKeyId).toBe(KEY_ID)
    expect(row?.kmsEncryptedDek).toBeTruthy()
    expect(row?.keyDerivationParams).toBeNull()
  })

  it('AC-9: unseal with empty body succeeds for kms-mode vault', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    const result = await unsealVault({})
    expect(result).toMatchObject({ unsealed: true, keyVersion: 1, kmsType: 'kms' })
  })

  it('AC-9 via HTTP: POST /vault/unseal with {} succeeds end-to-end through real HKDF/AES-GCM', async () => {
    const initApp = await createApp({ logger: false, vaultGuardEnabled: true })
    const initRes = await initApp.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'kms', kmsKeyId: KEY_ID },
    })
    expect(initRes.statusCode).toBe(200)
    await initApp.close()
    await restartSealed()

    const app = await createApp({ logger: false, vaultGuardEnabled: true })
    const res = await app.inject({ method: 'POST', url: UNSEAL_URL, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ unsealed: true, kmsType: 'kms' })
    await app.close()
  })

  it('AC-10: extraneous legacy field against a kms-mode vault is silently ignored', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    const result = await unsealVault({ passphrase: 'irrelevant-value-here' })
    expect(result).toMatchObject({ unsealed: true, kmsType: 'kms' })
  })

  it('AC-10 negative: an empty body against a passphrase-mode vault still 400s invalid_passphrase (unchanged)', async () => {
    await initVault({ kmsType: 'passphrase', passphrase: 'test-passphrase-12chars' }, {})
    await restartSealed()

    await expect(unsealVault({})).rejects.toMatchObject({
      code: 'INVALID_PASSPHRASE',
      statusCode: 400,
    })
  })

  it('AC-6: re-init against an already-initialized kms vault returns 409 and discards the fresh data key', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    const provider = makeFakeKmsProvider()
    __setKmsProviderForTest(provider)

    await expect(initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})).rejects.toMatchObject({
      code: 'ALREADY_INITIALIZED',
      statusCode: 409,
    })
    expect(provider.generateDataKey).toHaveBeenCalledTimes(1)
  })

  it('AC-14: sentinel mismatch after successful KMS decrypt still returns 401 unseal_failed', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.vault_test_reset', 'true', true)`)
      await tx.update(vaultState).set({
        encryptedSentinel: JSON.stringify({
          version: 1,
          iv: Buffer.alloc(12).toString('base64'),
          ciphertext: Buffer.alloc(16).toString('base64'),
          tag: Buffer.alloc(16).toString('base64'),
        }),
      })
    })

    await expect(unsealVault({})).rejects.toMatchObject({
      code: 'UNSEAL_FAILED',
      statusCode: 401,
    })
  })

  it('data-integrity edge: kms_type=kms with a NULL kms_encrypted_dek fails cleanly, not a crash', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.vault_test_reset', 'true', true)`)
      await tx.update(vaultState).set({ kmsEncryptedDek: null })
    })

    await expect(unsealVault({})).rejects.toMatchObject({
      code: 'VAULT_CORRUPTED',
      statusCode: 503,
    })
  })

  it('AC-15: two concurrent unseal calls against a kms-mode vault both converge on unsealed=true, no crash', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    const [a, b] = await Promise.allSettled([unsealVault({}), unsealVault({})])
    const outcomes = [a, b].map((r) =>
      r.status === 'fulfilled' ? r.value.unsealed : (r.reason as { code?: string }).code
    )
    // Either both succeed, or one succeeds and the other hits ALREADY_UNSEALED — never a crash.
    expect(outcomes.some((o) => o === true)).toBe(true)
    for (const o of outcomes) {
      expect(o === true || o === 'ALREADY_UNSEALED').toBe(true)
    }
  })

  it('AC-16: credential rotation is transparent — unseal succeeds via a fresh provider instance reading the same stored ciphertext', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    // Simulate "rotated credentials" by swapping in a brand-new provider instance that still
    // resolves the same ciphertext (the server never stores/depends on init-time credentials).
    const [row] = await getDb().select().from(vaultState).limit(1)
    const rotatedProvider = {
      generateDataKey: vi.fn(),
      decryptDataKey: vi.fn(async (blob: string) => {
        expect(blob).toBe(row?.kmsEncryptedDek)
        return Buffer.alloc(32, 7)
      }),
    }
    __setKmsProviderForTest(rotatedProvider)

    const result = await unsealVault({})
    expect(result).toMatchObject({ unsealed: true, kmsType: 'kms' })
  })

  it('AC-16 negative: narrowed credentials after rotation map to 403 kms_permission_denied, not a crash/hang', async () => {
    await initVault({ kmsType: 'kms', kmsKeyId: KEY_ID }, {})
    await restartSealed()

    __setKmsProviderForTest({
      generateDataKey: vi.fn(),
      decryptDataKey: vi.fn(async () => {
        throw new KmsProviderError('permission_denied', 'denied')
      }),
    })

    await expect(unsealVault({})).rejects.toMatchObject({
      code: 'KMS_PERMISSION_DENIED',
      statusCode: 403,
    })
  })

  it('AC-20: existing envelope-mode vaults are completely unaffected by kms-mode support', async () => {
    const { writeFileSync } = await import('node:fs')
    const { randomBytes } = await import('node:crypto')
    process.env['VAULT_ENVELOPE_KEY_HALF'] = randomBytes(16).toString('hex')
    const filePath = join(keyDir, 'envelope-half.bin')
    writeFileSync(filePath, randomBytes(16))

    const initResult = await initVault(
      { kmsType: 'envelope', envelopeKeyPath: filePath, acknowledgeSplitKeyModel: true },
      {}
    )
    expect(initResult).toMatchObject({ initialized: true, kmsType: 'envelope' })

    const [row] = await getDb().select().from(vaultState).limit(1)
    expect(row?.kmsKeyId).toBeNull()
    expect(row?.kmsEncryptedDek).toBeNull()

    await restartSealed()
    const unsealResult = await unsealVault({ envelopeKeyPath: filePath })
    expect(unsealResult).toMatchObject({ unsealed: true, kmsType: 'envelope' })
  })
})
