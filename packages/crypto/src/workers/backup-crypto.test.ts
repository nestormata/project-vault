import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptBackupBuffer, decryptBackupBuffer, BackupDecryptError } from './backup-crypto.js'

const KEY = randomBytes(32)
const SECRET_DUMP_PLAINTEXT = 'secret dump'

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
    const encrypted = encryptBackupBuffer(Buffer.from(SECRET_DUMP_PLAINTEXT), KEY)
    expect(() => decryptBackupBuffer(encrypted, randomBytes(32))).toThrow(BackupDecryptError)
  })

  it('throws BackupDecryptError on corrupted/tampered ciphertext', () => {
    const encrypted = encryptBackupBuffer(Buffer.from(SECRET_DUMP_PLAINTEXT), KEY)
    encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 0xff
    expect(() => decryptBackupBuffer(encrypted, KEY)).toThrow(BackupDecryptError)
  })

  it('throws BackupDecryptError on an unrecognized file format (bad magic)', () => {
    expect(() => decryptBackupBuffer(Buffer.from('not a backup file at all'), KEY)).toThrow(
      BackupDecryptError
    )
  })

  // Story 42.4 Task 7: the header-boundary truncation case — magic+IV present, GCM tag entirely
  // missing. This is the exact shape a crash mid-write of encryptBackupBuffer's output would leave
  // behind before atomicFileWrite's temp->rename even completes. The existing `< HEADER_BYTES`
  // guard should already catch this, but no existing test truncates at *exactly* this boundary
  // (existing tests use either a fully-valid buffer or an unrelated short nonsense string).
  it('Story 42.4 AC2/AC3/AC4: a buffer truncated to exactly MAGIC.length + IV_BYTES (tag entirely missing) throws BackupDecryptError, not a RangeError/TypeError', () => {
    const MAGIC_LENGTH = 4 // 'PVB1'
    const IV_BYTES = 12
    const encrypted = encryptBackupBuffer(Buffer.from(SECRET_DUMP_PLAINTEXT), KEY)
    const truncatedAtHeaderBoundary = encrypted.subarray(0, MAGIC_LENGTH + IV_BYTES)

    expect(truncatedAtHeaderBoundary).toHaveLength(MAGIC_LENGTH + IV_BYTES)
    let caught: unknown
    try {
      decryptBackupBuffer(truncatedAtHeaderBoundary, KEY)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BackupDecryptError)
    expect(caught).not.toBeInstanceOf(RangeError)
    expect(caught).not.toBeInstanceOf(TypeError)
  })

  // Story 42.4 Task 7: a complete, correctly-sized header (magic+IV+tag) but zero-length
  // ciphertext appended — a degenerate but size-valid shape. Proves the GCM auth-tag check (not
  // just the length check) is what's really load-bearing: the tag was computed over the real
  // gzip payload, so it must not authenticate an empty ciphertext as a false "empty string
  // decrypted successfully" positive.
  it('Story 42.4 AC2/AC3/AC4: a well-formed header with zero-length ciphertext does not falsely "succeed" — the auth-tag check rejects it', () => {
    const HEADER_BYTES = 4 + 12 + 16 // MAGIC + IV_BYTES + TAG_BYTES
    const encrypted = encryptBackupBuffer(Buffer.from(SECRET_DUMP_PLAINTEXT), KEY)
    const headerOnly = encrypted.subarray(0, HEADER_BYTES) // valid header, ciphertext dropped

    expect(headerOnly).toHaveLength(HEADER_BYTES)
    expect(() => decryptBackupBuffer(headerOnly, KEY)).toThrow(BackupDecryptError)
  })
})
