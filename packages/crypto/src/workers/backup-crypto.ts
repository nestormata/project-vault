import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_BYTES = 12 // 96-bit IV — GCM recommended size
const TAG_BYTES = 16 // GCM auth tag, fixed size
// Story 9.1 D2/AC-5: a distinct binary format from packages/crypto/src/aes.ts's hex-encoded
// EncryptedValue (used for small values like the vault sentinel/credential secrets) — a
// multi-megabyte backup file would double in size if hex-encoded. Format:
// [4-byte magic "PVB1"][12-byte IV][16-byte GCM tag][ciphertext...].
const MAGIC = Buffer.from('PVB1', 'ascii')
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES

export class BackupDecryptError extends Error {}

/** Encrypts an arbitrary-size buffer (gzipped pg_dump output) with AES-256-GCM. */
export function encryptBackupBuffer(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`encryptBackupBuffer: key must be 32 bytes, got ${key.length}`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, iv, tag, ciphertext])
}

/** Decrypts a buffer produced by `encryptBackupBuffer`. Throws `BackupDecryptError` on a GCM
 * auth-tag mismatch (wrong key or corrupted/tampered ciphertext) — deliberately no distinction
 * between the two, same "no oracle" discipline as the vault's own unseal error (Story 1.5). */
export function decryptBackupBuffer(encrypted: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`decryptBackupBuffer: key must be 32 bytes, got ${key.length}`)
  }
  if (encrypted.length < HEADER_BYTES || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupDecryptError('decryptBackupBuffer: unrecognized backup file format')
  }
  const iv = encrypted.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = encrypted.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES)
  const ciphertext = encrypted.subarray(HEADER_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (cause) {
    throw new BackupDecryptError(
      'decryptBackupBuffer: decryption failed — invalid key or corrupted/tampered ciphertext',
      { cause }
    )
  }
}
