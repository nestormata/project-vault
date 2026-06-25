import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { EncryptedValue } from './types.js'

const IV_BYTES = 12 // 96-bit IV — GCM recommended size
const VERSION = 1 // ciphertext format version — increment on algorithm change

export async function encrypt(plaintext: Buffer, key: Buffer): Promise<EncryptedValue> {
  if (key.length !== 32) throw new Error(`aes.encrypt: key must be 32 bytes, got ${key.length}`)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag() // always 16 bytes with GCM default
  return {
    version: VERSION,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

// Internal only — callers outside packages/crypto must use withSecret()
export async function decrypt(encrypted: EncryptedValue, key: Buffer): Promise<Buffer> {
  if (encrypted.version !== VERSION) {
    throw new Error(
      `aes.decrypt: unsupported version ${encrypted.version}; only version ${VERSION} supported`
    )
  }
  if (key.length !== 32) throw new Error(`aes.decrypt: key must be 32 bytes, got ${key.length}`)
  const iv = Buffer.from(encrypted.iv, 'hex')
  const ciphertext = Buffer.from(encrypted.ciphertext, 'hex')
  const tag = Buffer.from(encrypted.tag, 'hex')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag) // GCM auth-tag check is constant-time inside OpenSSL
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new Error('Decryption failed: invalid key or corrupted ciphertext', { cause: err })
  }
}
