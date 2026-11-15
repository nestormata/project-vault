import { createVerifier } from 'fast-jwt'
import { env } from '../../config/env.js'

export const IDENTITY_REVOCATION_MAX_TTL_SECONDS = 60
export const IDENTITY_REVOCATION_ALGORITHM = 'HS256' as const

export type IdentityRevocationClaims = {
  iss: string
  sub: string
  aud: string
  jti: string
  iat: number
  exp: number
}

export type IdentityRevocationVerifyReason =
  | 'unset_secret'
  | 'unset_instance_id'
  | 'malformed'
  | 'signature_invalid'
  | 'audience_mismatch'
  | 'expired'
  | 'ttl_exceeded'
  | 'missing_claim'

export type IdentityRevocationVerifyResult =
  | { ok: true; claims: IdentityRevocationClaims }
  | { ok: false; reason: IdentityRevocationVerifyReason }

export function expectedIdentityRevocationAudience(instanceId: string): string {
  return `node:${instanceId}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asBoundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length >= 1 && value.length <= max ? value : null
}

function tokenErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function decodeIdentityRevocationPayload(
  token: string,
  secret: string
): IdentityRevocationVerifyResult | { ok: 'payload'; payload: unknown } {
  try {
    const verify = createVerifier({
      key: secret,
      algorithms: [IDENTITY_REVOCATION_ALGORITHM],
    })
    return { ok: 'payload', payload: verify(token) }
  } catch (error) {
    if (tokenErrorCode(error) === 'FAST_JWT_EXPIRED') return { ok: false, reason: 'expired' }
    return { ok: false, reason: 'signature_invalid' }
  }
}

function boundIdentityRevocationClaims(
  claims: Record<string, unknown>
): IdentityRevocationClaims | null {
  const iss = asBoundedString(claims.iss, 256)
  const sub = asBoundedString(claims.sub, 256)
  const jti = asBoundedString(claims.jti, 128)
  const aud = asBoundedString(claims.aud, 256)
  const iat = typeof claims.iat === 'number' ? claims.iat : null
  const exp = typeof claims.exp === 'number' ? claims.exp : null
  if (!iss || !sub || !jti || !aud || iat === null || exp === null) return null
  return { iss, sub, aud, jti, iat, exp }
}

function parseIdentityRevocationClaims(
  payload: unknown,
  instanceId: string
): IdentityRevocationVerifyResult {
  const record = asRecord(payload)
  if (!record) return { ok: false, reason: 'malformed' }
  const claims = boundIdentityRevocationClaims(record)
  if (!claims) return { ok: false, reason: 'missing_claim' }
  if (claims.aud !== expectedIdentityRevocationAudience(instanceId)) {
    return { ok: false, reason: 'audience_mismatch' }
  }
  if (claims.exp - claims.iat > IDENTITY_REVOCATION_MAX_TTL_SECONDS) {
    return { ok: false, reason: 'ttl_exceeded' }
  }
  return { ok: true, claims }
}

export function verifyIdentityRevocationJwt(
  token: string,
  deps: { secret?: string; instanceId?: string } = {
    secret: env.IDENTITY_REVOCATION_JWT_SECRET,
    instanceId: env.VAULT_HANDOFF_INSTANCE_ID,
  }
): IdentityRevocationVerifyResult {
  if (!deps.secret) return { ok: false, reason: 'unset_secret' }
  if (!deps.instanceId) return { ok: false, reason: 'unset_instance_id' }
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'malformed' }

  const decoded = decodeIdentityRevocationPayload(token, deps.secret)
  if (decoded.ok !== 'payload') return decoded
  return parseIdentityRevocationClaims(decoded.payload, deps.instanceId)
}

export function bearerTokenFromAuthorization(
  authorization: string | string[] | undefined
): string | null {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization
  if (!raw) return null
  const match = /^Bearer\s+(\S+)$/i.exec(raw)
  return match?.[1] ?? null
}
