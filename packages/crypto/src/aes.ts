import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { EncryptedValue } from './types.js'

// Story 8-6 AC-10 — this AES-256-GCM/HKDF envelope is deliberately duplicated (not imported) in
// two other independently-versioned artifacts: `packages/agent/src/cache-crypto.ts` and, bundled
// from that same source, `packages/vault-action/dist/index.js` (see 7.2 D11 for why each copy
// exists). A security-relevant change to this file requires, before it can be considered done:
//   1. Re-run the cross-compat test (`apps/api/src/__tests__/agent-crypto-cross-compat.test.ts`)
//      to confirm the two source implementations are still byte-for-byte interoperable.
//   2. Port the same fix into `packages/agent/src/cache-crypto.ts` and rebuild
//      `packages/vault-action/dist/` (`pnpm --filter @project-vault/vault-action build`, verified
//      fresh by `scripts/check-vault-action-dist-fresh.ts`).
//   3. Cut a `vault-action` re-tag/release so CI consumers of the mutable `v1` tag actually pick up
//      the fix (see 7.3 D7 on why that tag's release process matters).
// This is a documented process control, not automation — no build-graph dependency-change-detector
// enforces it; see `packages/agent/SECURITY.md` for the full checklist.
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
