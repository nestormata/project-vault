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
    expect(encrypted.iv).toHaveLength(24)
    expect(encrypted.tag).toHaveLength(32)
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
    const captured: Buffer[] = []
    await withSecret(encrypted, async (buf) => {
      captured.push(buf)
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.every((b) => b === 0)).toBe(true)
  })

  it('zeros the plaintext Buffer even if callback throws', async () => {
    const encrypted = await encrypt(Buffer.from('zero-on-error', 'utf8'), testKey)
    const captured: Buffer[] = []
    await expect(
      withSecret(encrypted, async (buf) => {
        captured.push(buf)
        throw new Error('callback error')
      })
    ).rejects.toThrow('callback error')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.every((b) => b === 0)).toBe(true)
  })

  it('rejects unsupported ciphertext version', async () => {
    const encrypted = await encrypt(Buffer.from('test', 'utf8'), testKey)
    const tampered: EncryptedValue = { ...encrypted, version: 2 }
    await expect(withSecret(tampered, async (b) => b)).rejects.toThrow(/unsupported version/)
  })
})

describe('HKDF-SHA256 key derivation', () => {
  it('produces 32-byte keys', () => {
    const ikm = randomBytes(32)
    const key = deriveKey(ikm, HKDF_INFO.PRIMARY)
    expect(key).toHaveLength(32)
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
  afterEach(() => {
    clearVaultKey()
  })

  it('reports key presence correctly', () => {
    clearVaultKey()
    expect(isVaultKeySet()).toBe(false)
    setVaultKey(randomBytes(32))
    expect(isVaultKeySet()).toBe(true)
    clearVaultKey()
    expect(isVaultKeySet()).toBe(false)
  })
})
