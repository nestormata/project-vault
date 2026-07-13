import { describe, expect, it } from 'vitest'
import { generateInvitationToken, hashInvitationToken, invitationTokensMatch } from './tokens.js'

describe('invitation tokens', () => {
  it('generateInvitationToken produces a URL-safe, non-empty opaque token', () => {
    const token = generateInvitationToken()
    expect(token.length).toBeGreaterThan(0)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generateInvitationToken()).not.toBe(token)
  })

  it('hashInvitationToken is a deterministic 64-char hex HMAC of the opaque value', () => {
    const opaque = generateInvitationToken()
    const hash = hashInvitationToken(opaque)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInvitationToken(opaque)).toBe(hash)
  })

  it('invitationTokensMatch rejects a stored hash that is not 64 hex characters', () => {
    expect(invitationTokensMatch('not-a-hash', 'anything')).toBe(false)
  })

  it('invitationTokensMatch returns true when the opaque token hashes to the stored hash', () => {
    const opaque = generateInvitationToken()
    const stored = hashInvitationToken(opaque)
    expect(invitationTokensMatch(stored, opaque)).toBe(true)
  })

  it('invitationTokensMatch returns false when the opaque token hashes to a different value', () => {
    const opaque = generateInvitationToken()
    const stored = hashInvitationToken(generateInvitationToken())
    expect(invitationTokensMatch(stored, opaque)).toBe(false)
  })
})
