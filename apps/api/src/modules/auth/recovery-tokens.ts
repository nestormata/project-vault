import { env } from '../../config/env.js'
import { generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches } from '../../lib/opaque-token.js'

export function generateRecoveryToken(): string {
  return generateOpaqueToken(32)
}

export function hashRecoveryToken(opaque: string): string {
  return hashOpaqueToken(env.RECOVERY_TOKEN_HMAC_SECRET, opaque)
}

export function recoveryTokensMatch(storedHash: string, opaque: string): boolean {
  return opaqueTokenMatches(env.RECOVERY_TOKEN_HMAC_SECRET, storedHash, opaque)
}

/**
 * AC-13: masks the local part of an email for the public token-peek response — a leaked/logged
 * recovery URL is a more direct account-takeover vector than a leaked invitation link, so (unlike
 * the invitation peek, which shows the full address to the intended recipient) this masks by
 * design. Algorithm: keep the first 2 local-part characters (1 if the local part is 1-2 chars
 * long), replace the remainder with a fixed-width "***", and leave the domain untouched.
 */
export function maskRecoveryEmail(email: string): string {
  const atIndex = email.indexOf('@')
  if (atIndex === -1) return email
  const local = email.slice(0, atIndex)
  const domain = email.slice(atIndex + 1)
  const visibleLength = local.length <= 2 ? 1 : 2
  return `${local.slice(0, visibleLength)}***@${domain}`
}
