import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { VaultCacheDecryptionError } from './errors.js'

export type EncryptedValue = {
  version: number
  iv: string
  ciphertext: string
  tag: string
}

const IV_BYTES = 12 // 96-bit IV — GCM recommended size
const VERSION = 1
const KEY_BYTES = 32 // 256-bit AES key

// Story 7.2 D11 — this cache-encryption module is deliberately self-contained (uses `node:crypto`
// directly) rather than a workspace dependency on `@project-vault/crypto`: that package is
// `"private": true` like every other workspace package and has never been published, but
// `@project-vault/agent` must be independently publishable/installable outside this monorepo
// (external CI runners only `npm install @project-vault/agent`, they never clone the monorepo).
//
// Cross-reference: `packages/crypto/src/aes.ts` + `packages/crypto/src/kdf.ts`. The algorithm
// (AES-256-GCM), IV length (96 bits), auth-tag handling, hex encoding, and envelope shape
// (`{ version, iv, ciphertext, tag }`) are deliberately byte-for-byte identical to that package —
// this is not "reinventing the wheel," it is avoiding an unpublishable dependency while
// deliberately copying an already-reviewed algorithm choice. A dedicated cross-compatibility test
// in `apps/api` (the only workspace that can depend on both packages) encrypts with one
// implementation and decrypts with the other, in both directions, to prove this claim rather than
// just asserting it in a comment.
export const CACHE_KDF_INFO = 'project-vault-agent-cache-v1'

/** Derives a 256-bit AES cache key from the plaintext API key. Salt is intentionally empty. */
export function deriveCacheKey(apiKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(apiKey, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(CACHE_KDF_INFO, 'utf8'),
      KEY_BYTES
    )
  )
}

export function encryptForCache(plaintext: string, key: Buffer): EncryptedValue {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryptForCache: key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    version: VERSION,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
}

/**
 * AC-13 — never falls back to plaintext on failure: a mismatched key (e.g. cache written under a
 * pre-rotation key) or a tampered ciphertext/tag makes GCM's auth-tag check fail, which we always
 * rewrap as `VaultCacheDecryptionError` rather than letting a raw crypto error escape or, worse,
 * returning partially-decrypted bytes.
 */
export function decryptFromCache(encrypted: EncryptedValue, key: Buffer): string {
  if (encrypted.version !== VERSION) {
    throw new VaultCacheDecryptionError(
      `Unsupported cache envelope version ${encrypted.version} (expected ${VERSION}).`
    )
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`decryptFromCache: key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
  try {
    const iv = Buffer.from(encrypted.iv, 'hex')
    const ciphertext = Buffer.from(encrypted.ciphertext, 'hex')
    const tag = Buffer.from(encrypted.tag, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch (error) {
    throw new VaultCacheDecryptionError(
      `${new VaultCacheDecryptionError().message} (${error instanceof Error ? error.message : String(error)})`
    )
  }
}
