import { env } from '../../config/env.js'
import { generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches } from '../../lib/opaque-token.js'

// Story 6.3 ADR-6.3-06: reuses the shared opaque-token-plus-HMAC-hash primitives verbatim,
// mirroring recovery-tokens.ts's exact shape. generateOpaqueToken(32) yields 256 bits of entropy
// encoded as 43 base64url characters — exceeding epics.md's literal "22+ base62 chars / 128-bit
// minimum" requirement in both entropy and length, and base64url is URL-safe by construction.
export function generateStatusPageToken(): string {
  return generateOpaqueToken(32)
}

export function hashStatusPageToken(opaque: string): string {
  return hashOpaqueToken(env.STATUS_PAGE_TOKEN_HMAC_SECRET, opaque)
}

export function statusPageTokenMatches(storedHash: string, opaque: string): boolean {
  return opaqueTokenMatches(env.STATUS_PAGE_TOKEN_HMAC_SECRET, storedHash, opaque)
}
