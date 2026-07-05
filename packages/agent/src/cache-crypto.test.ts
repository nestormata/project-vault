import { describe, expect, it } from 'vitest'
import { decryptFromCache, deriveCacheKey, encryptForCache } from './cache-crypto.js'
import { VaultCacheDecryptionError } from './errors.js'

const SECRET_VALUE = 'secret-value'

describe('cache-crypto', () => {
  it('round-trips a plaintext value through encrypt -> decrypt', () => {
    const key = deriveCacheKey('pk_test-api-key-1234567890')
    const encrypted = encryptForCache('postgres://prod-user:secret@db.internal:5432/app', key)

    expect(encrypted.version).toBe(1)
    expect(encrypted.iv).toMatch(/^[0-9a-f]+$/)
    expect(encrypted.ciphertext).toMatch(/^[0-9a-f]+$/)
    expect(encrypted.tag).toMatch(/^[0-9a-f]+$/)

    const decrypted = decryptFromCache(encrypted, key)
    expect(decrypted).toBe('postgres://prod-user:secret@db.internal:5432/app')
  })

  it('derives different keys for different API keys', () => {
    const keyA = deriveCacheKey('pk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const keyB = deriveCacheKey('pk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(keyA.equals(keyB)).toBe(false)
  })

  it('throws VaultCacheDecryptionError (never plaintext fallback) when decrypting with the wrong key', () => {
    const keyA = deriveCacheKey('pk_original-key-aaaaaaaaaaaaaaaaaa')
    const keyB = deriveCacheKey('pk_rotated-key-bbbbbbbbbbbbbbbbbbb')
    const encrypted = encryptForCache(SECRET_VALUE, keyA)

    expect(() => decryptFromCache(encrypted, keyB)).toThrow(VaultCacheDecryptionError)
  })

  it('throws VaultCacheDecryptionError when the ciphertext has been tampered with', () => {
    const key = deriveCacheKey('pk_tamper-test-key-aaaaaaaaaaaaaaa')
    const encrypted = encryptForCache(SECRET_VALUE, key)
    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.replace(/^../, 'ff') }

    expect(() => decryptFromCache(tampered, key)).toThrow(VaultCacheDecryptionError)
  })

  it('throws VaultCacheDecryptionError for an unsupported envelope version', () => {
    const key = deriveCacheKey('pk_version-test-key-aaaaaaaaaaaaa')
    const encrypted = encryptForCache(SECRET_VALUE, key)

    expect(() => decryptFromCache({ ...encrypted, version: 99 }, key)).toThrow(
      VaultCacheDecryptionError
    )
  })
})
