import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

/**
 * Story 72-11 — the pure pieces of guest recipient verification for native external shares: code
 * and proof generation, their at-rest hashes and constant-time comparisons, and the masked
 * recipient address. Nothing here touches the database, logs, or returns a code to a caller other
 * than the one that generated it.
 */

const CODE_PATTERN = /^\d{6}$/
const HEX_SHA256_LENGTH = 64

/** A 6-digit code from the CSPRNG (`randomInt` is uniform, no modulo bias), zero padded. */
export function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** V3: HMAC-SHA256 keyed by the RAW share token over `shareId:code`. The token is never stored, so
 *  a leaked database alone cannot brute-force the 10^6 code space offline. */
export function hashVerificationCode(rawToken: string, shareId: string, code: string): string {
  return createHmac('sha256', rawToken).update(`${shareId}:${code}`).digest('hex')
}

function hexDigestsEqual(left: string, right: string): boolean {
  if (left.length !== HEX_SHA256_LENGTH || right.length !== HEX_SHA256_LENGTH) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Constant-time compare of a submitted code against the stored hash. A malformed code is hashed
 *  anyway (and never matches), so the comparison cost does not depend on the input's shape. */
export function verificationCodeMatches(
  rawToken: string,
  shareId: string,
  code: string,
  storedHash: string | null
): boolean {
  const candidate = hashVerificationCode(rawToken, shareId, code)
  if (storedHash === null) return false
  return hexDigestsEqual(candidate, storedHash) && CODE_PATTERN.test(code)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** V8: 32 random bytes (base64url), returned once to the guest; only the SHA-256 is stored. */
export function generateVerificationProof(): { proof: string; proofHash: string } {
  const proof = randomBytes(32).toString('base64url')
  return { proof, proofHash: sha256Hex(proof) }
}

export function verificationProofMatches(
  proof: string | undefined,
  storedHash: string | null
): boolean {
  if (proof === undefined || storedHash === null) return false
  return hexDigestsEqual(sha256Hex(proof), storedHash)
}

/** V6: first character of the local part, three stars, `@`, first character of the domain, three
 *  stars. No TLD and no length, so the mask narrows nothing usable. */
export function maskRecipientEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  const at = normalized.lastIndexOf('@')
  const local = at > 0 ? normalized.slice(0, at) : normalized
  const domain = at > 0 ? normalized.slice(at + 1) : ''
  return `${maskInitial(local)}***@${maskInitial(domain)}***`
}

const LOWERCASE_LETTER_COUNT = 26
const MASK_ALPHABET_SIZE = LOWERCASE_LETTER_COUNT + 10
const LOWERCASE_A = 97

/** The one visible character of a mask part, limited to the alphabet a synthetic mask draws from,
 *  so a real mask can never be told from a fake one by the kind of character it shows. */
function maskInitial(part: string): string {
  const first = part.charAt(0)
  return /^[a-z0-9]$/.test(first) ? first : 'x'
}

/** V6: the mask for a token that resolves to no external recipient: the same shape, derived from a
 *  keyed HMAC of the token (a fixed server key, domain separated from the share-token hash), so
 *  repeated requests for one token agree and a fake mask cannot be told from a real one. */
function syntheticMaskForToken(rawToken: string): string {
  const digest = createHmac('sha256', env.INVITATION_TOKEN_HMAC_SECRET)
    .update(`credential_share_mask:${rawToken}`)
    .digest()
  const pick = (byte: number | undefined) => {
    const n = (byte ?? 0) % MASK_ALPHABET_SIZE
    return n < LOWERCASE_LETTER_COUNT
      ? String.fromCodePoint(LOWERCASE_A + n)
      : String(n - LOWERCASE_LETTER_COUNT)
  }
  return `${pick(digest[0])}***@${pick(digest[1])}***`
}

/** The masked address answered for a token: the real recipient's when the token resolved to an
 *  external share with an address, otherwise the deterministic synthetic one. */
export function maskedRecipientFor(rawToken: string, recipientEmail: string | null): string {
  return recipientEmail ? maskRecipientEmail(recipientEmail) : syntheticMaskForToken(rawToken)
}
