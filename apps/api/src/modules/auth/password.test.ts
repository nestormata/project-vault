import { describe, expect, it } from 'vitest'
import { generateUnusablePasswordHash, verifyUserPassword } from './password.js'

/**
 * Story 23.2 AC-6e: the single shared implementation of "a freshly-generated, per-user random,
 * non-functional password hash, never a fixed shared constant" — now used by
 * auth/sso-routes.ts, platform-admin/service.ts, and compliance/erasure-service.ts alike.
 */
describe('generateUnusablePasswordHash (AC-6e)', () => {
  it('produces a valid Argon2 PHC-format hash', async () => {
    const hash = await generateUnusablePasswordHash()
    expect(hash).toMatch(/^\$argon2id\$/)
  })

  it('produces a DIFFERENT hash on every call — never a fixed shared constant', async () => {
    const [first, second] = await Promise.all([
      generateUnusablePasswordHash(),
      generateUnusablePasswordHash(),
    ])
    expect(first).not.toBe(second)
  })

  it('is not a functional credential for any guessable password — it is random preimage material', async () => {
    const hash = await generateUnusablePasswordHash()
    // Nobody can supply the correct password because the preimage was randomly generated and
    // discarded, never returned or stored anywhere — this is a smoke assertion that at least a
    // handful of plausible guesses all fail, not a proof (which would require the discarded
    // preimage).
    const results = await Promise.all(
      ['', 'password', 'admin', 'letmein'].map((guess) => verifyUserPassword(guess, hash))
    )
    expect(results).toEqual([false, false, false, false])
  })
})
