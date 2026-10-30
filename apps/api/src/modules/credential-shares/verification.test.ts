import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  generateVerificationCode,
  generateVerificationProof,
  hashVerificationCode,
  maskedRecipientFor,
  maskRecipientEmail,
  verificationCodeMatches,
  verificationProofMatches,
} from './verification.js'

const TOKEN = 'a'.repeat(43)
const OTHER_TOKEN = 'b'.repeat(43)
const SHARE_ID = randomUUID()
const OTHER_SHARE_ID = randomUUID()
const MASK_SHAPE = /^[a-z0-9]\*\*\*@[a-z0-9]\*\*\*$/

describe('external share verification helpers (Story 72-11)', () => {
  it('generates six-digit codes, zero padded, from a CSPRNG', () => {
    const codes = Array.from({ length: 200 }, () => generateVerificationCode())
    for (const code of codes) expect(code).toMatch(/^\d{6}$/)
    expect(new Set(codes).size).toBeGreaterThan(190)
  })

  it('V3: hashes a code with the raw token as the HMAC key, bound to the share id', () => {
    const hash = hashVerificationCode(TOKEN, SHARE_ID, '123456')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('123456')
    expect(hashVerificationCode(OTHER_TOKEN, SHARE_ID, '123456')).not.toBe(hash)
    expect(hashVerificationCode(TOKEN, OTHER_SHARE_ID, '123456')).not.toBe(hash)
  })

  it('matches only the exact code for the same token and share', () => {
    const stored = hashVerificationCode(TOKEN, SHARE_ID, '012345')
    expect(verificationCodeMatches(TOKEN, SHARE_ID, '012345', stored)).toBe(true)
    expect(verificationCodeMatches(TOKEN, SHARE_ID, '012346', stored)).toBe(false)
    expect(verificationCodeMatches(OTHER_TOKEN, SHARE_ID, '012345', stored)).toBe(false)
    expect(verificationCodeMatches(TOKEN, SHARE_ID, '012345', null)).toBe(false)
    expect(verificationCodeMatches(TOKEN, SHARE_ID, '012345', 'short')).toBe(false)
  })

  it('rejects a code that is not exactly six digits without matching', () => {
    const stored = hashVerificationCode(TOKEN, SHARE_ID, '000000')
    expect(verificationCodeMatches(TOKEN, SHARE_ID, '0', stored)).toBe(false)
    expect(verificationCodeMatches(TOKEN, SHARE_ID, '', stored)).toBe(false)
  })

  it('V8: a proof is 32 random bytes in base64url and only its SHA-256 is kept', () => {
    const { proof, proofHash } = generateVerificationProof()
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(proofHash).toBe(createHash('sha256').update(proof).digest('hex'))
    expect(verificationProofMatches(proof, proofHash)).toBe(true)
    expect(verificationProofMatches(`${proof}x`, proofHash)).toBe(false)
    expect(verificationProofMatches(undefined, proofHash)).toBe(false)
    expect(verificationProofMatches(proof, null)).toBe(false)
    expect(generateVerificationProof().proof).not.toBe(proof)
  })

  it('V6: masks the address to first character, three stars, @, first character, three stars', () => {
    expect(maskRecipientEmail('nestor@gmail.com')).toBe('n***@g***')
    expect(maskRecipientEmail('X@Y.example')).toBe('x***@y***')
  })

  it('V6: an unknown token gets a mask of the same shape, deterministic per token', () => {
    const first = maskedRecipientFor(TOKEN, null)
    expect(first).toMatch(MASK_SHAPE)
    expect(maskedRecipientFor(TOKEN, null)).toBe(first)
    const masks = new Set(
      Array.from({ length: 50 }, (_, index) => maskedRecipientFor(`${TOKEN}${index}`, null))
    )
    expect(masks.size).toBeGreaterThan(10)
  })

  it('V6: a resolved share uses its real recipient address', () => {
    expect(maskedRecipientFor(TOKEN, 'priya@vendor.example')).toBe('p***@v***')
  })
})
