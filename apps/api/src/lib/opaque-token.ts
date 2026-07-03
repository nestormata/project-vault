import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Shared primitives behind this codebase's opaque-token-plus-HMAC-hash trust model (invitation
 * tokens, recovery tokens, refresh tokens, pending-MFA tokens all follow this exact shape:
 * generate a random opaque value, store only its HMAC hash, compare in constant time). Extracted
 * here so new token types (e.g. Story 4.3's recovery tokens) reuse the hash/compare logic instead
 * of re-deriving it.
 */
export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

export function hashOpaqueToken(secret: string, opaque: string): string {
  return createHmac('sha256', secret).update(opaque).digest('hex')
}

export function opaqueTokenMatches(secret: string, storedHash: string, opaque: string): boolean {
  const computed = hashOpaqueToken(secret, opaque)
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false
  if (storedHash.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(computed, 'hex'))
}
