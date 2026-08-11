import { env } from '../../config/env.js'
import { generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches } from '../../lib/opaque-token.js'

// Story 1.19 D6/AC-6: reuses the shared opaque-token-plus-HMAC-hash primitives verbatim, same
// shape as modules/monitoring/status-page-tokens.ts (Story 6.3) — but keyed with its own
// dedicated OPERATIONAL_STATUS_TOKEN_HMAC_SECRET, never the public status-page secret. This is
// the bearer token an operator generates in Settings to protect GET /status (the internal
// operational aggregate probe), not the unrelated public customer-facing status page.
export function generateOperationalStatusToken(): string {
  return generateOpaqueToken(32)
}

export function hashOperationalStatusToken(opaque: string): string {
  return hashOpaqueToken(env.OPERATIONAL_STATUS_TOKEN_HMAC_SECRET, opaque)
}

export function operationalStatusTokenMatches(storedHash: string, opaque: string): boolean {
  return opaqueTokenMatches(env.OPERATIONAL_STATUS_TOKEN_HMAC_SECRET, storedHash, opaque)
}
