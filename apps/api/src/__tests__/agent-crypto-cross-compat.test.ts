import { describe, expect, it } from 'vitest'
// bootstrapDecrypt is packages/crypto's one sanctioned raw-decrypt export (see
// packages/crypto/src/index.ts) — appropriate here since this test is exactly the kind of
// infrastructure/interoperability check that export exists for, not general application code.
// Not aliased to `decrypt` — the repo's no-bare-decrypt eslint rule matches on the local
// identifier name, and this file's override only allows the literal `bootstrapDecrypt` name.
import { bootstrapDecrypt, deriveKey, encrypt } from '@project-vault/crypto'
import {
  decryptFromCache,
  deriveCacheKey,
  encryptForCache,
} from '@project-vault/agent/cache-crypto'

/**
 * Story 7.2 D11 — the offline agent's cache encryption (packages/agent/src/cache-crypto.ts) is a
 * self-contained reimplementation of packages/crypto/src/aes.ts + kdf.ts, not a shared dependency
 * (packages/agent must be independently publishable/installable outside this monorepo, but
 * @project-vault/crypto is a private, unpublished workspace package). The two are claimed to be
 * byte-for-byte interoperable — this is the mandatory test proving that claim (Task 16), run in
 * apps/api since it's the only workspace that can depend on both packages. If a future edit to
 * either implementation breaks interoperability, this test fails immediately instead of surfacing
 * as a confusing production decrypt failure.
 */
describe('packages/crypto <-> packages/agent cache-crypto interoperability (D11)', () => {
  const plaintext = 'postgres://prod-user:s3cr3t@db.internal:5432/app'

  it('decrypts a value encrypted by packages/crypto/src/aes.ts using packages/agent/src/cache-crypto.ts', async () => {
    const apiKey = 'pk_cross-compat-test-key-aaaaaaaaaaaaaaaaaaaaaa'
    const key = deriveKey(Buffer.from(apiKey, 'utf8'), 'project-vault-agent-cache-v1')

    const encrypted = await encrypt(Buffer.from(plaintext, 'utf8'), key)
    const decrypted = decryptFromCache(encrypted, key)

    expect(decrypted).toBe(plaintext)
  })

  it('decrypts a value encrypted by packages/agent/src/cache-crypto.ts using packages/crypto/src/aes.ts', async () => {
    const apiKey = 'pk_cross-compat-test-key-bbbbbbbbbbbbbbbbbbbbbb'
    const key = deriveCacheKey(apiKey)

    const encrypted = encryptForCache(plaintext, key)
    const decrypted = await bootstrapDecrypt(encrypted, key)

    expect(decrypted.toString('utf8')).toBe(plaintext)
  })

  it('derives byte-identical keys given the same IKM and info string', () => {
    const apiKey = 'pk_cross-compat-test-key-cccccccccccccccccccccc'
    const keyFromCrypto = deriveKey(Buffer.from(apiKey, 'utf8'), 'project-vault-agent-cache-v1')
    const keyFromAgent = deriveCacheKey(apiKey)

    expect(keyFromAgent.equals(keyFromCrypto)).toBe(true)
  })
})
