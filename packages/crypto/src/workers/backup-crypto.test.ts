import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptBackupBuffer, decryptBackupBuffer, BackupDecryptError } from './backup-crypto.js'

const KEY = randomBytes(32)

describe('Story 9.1 D5/AC-5: backup encrypt/decrypt', () => {
  it('round-trips arbitrary plaintext', () => {
    const plaintext = Buffer.from('gzipped pg_dump bytes go here'.repeat(1000))
    const encrypted = encryptBackupBuffer(plaintext, KEY)
    const decrypted = decryptBackupBuffer(encrypted, KEY)
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  it('produces different ciphertext for the same plaintext on each call (random IV)', () => {
    const plaintext = Buffer.from('same input')
    const a = encryptBackupBuffer(plaintext, KEY)
    const b = encryptBackupBuffer(plaintext, KEY)
    expect(a.equals(b)).toBe(false)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptBackupBuffer(Buffer.from('x'), randomBytes(16))).toThrow(/32 bytes/)
  })

  it('throws BackupDecryptError on wrong key (AC-9 no-oracle discipline)', () => {
    const encrypted = encryptBackupBuffer(Buffer.from('secret dump'), KEY)
    expect(() => decryptBackupBuffer(encrypted, randomBytes(32))).toThrow(BackupDecryptError)
  })

  it('throws BackupDecryptError on corrupted/tampered ciphertext', () => {
    const encrypted = encryptBackupBuffer(Buffer.from('secret dump'), KEY)
    encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 0xff
    expect(() => decryptBackupBuffer(encrypted, KEY)).toThrow(BackupDecryptError)
  })

  it('throws BackupDecryptError on an unrecognized file format (bad magic)', () => {
    expect(() => decryptBackupBuffer(Buffer.from('not a backup file at all'), KEY)).toThrow(
      BackupDecryptError
    )
  })
})
