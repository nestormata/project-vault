import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashInvitationToken(opaque: string): string {
  return createHmac('sha256', env.INVITATION_TOKEN_HMAC_SECRET).update(opaque).digest('hex')
}

export function invitationTokensMatch(storedHash: string, opaque: string): boolean {
  const computed = hashInvitationToken(opaque)
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false
  if (storedHash.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(computed, 'hex'))
}
