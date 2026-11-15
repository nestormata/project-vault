import { generateKeyPairSync } from 'node:crypto'
import { createSigner } from 'fast-jwt'
import { describe, expect, it } from 'vitest'
import {
  IDENTITY_REVOCATION_ALGORITHM,
  IDENTITY_REVOCATION_MAX_TTL_SECONDS,
  bearerTokenFromAuthorization,
  expectedIdentityRevocationAudience,
  verifyIdentityRevocationJwt,
} from './identity-revocation-jwt.js'

const SECRET = 'identity-revocation-jwt-test-secret-32b'
const INSTANCE_ID = 'pv-test'
const AUD = expectedIdentityRevocationAudience(INSTANCE_ID)

function sign(claims: Record<string, unknown>, expiresIn = 60_000, key = SECRET): string {
  return createSigner({ key, algorithm: IDENTITY_REVOCATION_ALGORITHM, expiresIn })({
    iss: 'workos',
    sub: 'user_abc',
    aud: AUD,
    jti: 'jti-1',
    ...claims,
  }) as string
}

describe('verifyIdentityRevocationJwt', () => {
  const deps = { secret: SECRET, instanceId: INSTANCE_ID }

  it('accepts a HS256 token with aud node:<instance>, unused-shaped claims, and ttl <= 60s', () => {
    const token = sign({})
    const result = verifyIdentityRevocationJwt(token, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims.iss).toBe('workos')
    expect(result.claims.sub).toBe('user_abc')
    expect(result.claims.aud).toBe(AUD)
    expect(result.claims.jti).toBe('jti-1')
    expect(result.claims.exp - result.claims.iat).toBeLessThanOrEqual(
      IDENTITY_REVOCATION_MAX_TTL_SECONDS
    )
  })

  it('rejects an unset secret and unset instance id', () => {
    expect(verifyIdentityRevocationJwt(sign({}), { instanceId: INSTANCE_ID })).toEqual({
      ok: false,
      reason: 'unset_secret',
    })
    expect(verifyIdentityRevocationJwt(sign({}), { secret: SECRET })).toEqual({
      ok: false,
      reason: 'unset_instance_id',
    })
  })

  it('rejects a bad signature, wrong audience, expired token, and ttl > 60s with distinct reasons', () => {
    expect(verifyIdentityRevocationJwt(sign({}, 60_000, 'x'.repeat(SECRET.length)), deps)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })
    expect(verifyIdentityRevocationJwt(sign({ aud: 'node:other' }), deps)).toEqual({
      ok: false,
      reason: 'audience_mismatch',
    })
    expect(verifyIdentityRevocationJwt(sign({ aud: `pv:${INSTANCE_ID}` }), deps)).toEqual({
      ok: false,
      reason: 'audience_mismatch',
    })
    const now = Math.floor(Date.now() / 1000)
    const expired = createSigner({ key: SECRET, algorithm: IDENTITY_REVOCATION_ALGORITHM })({
      iss: 'workos',
      sub: 'user_abc',
      aud: AUD,
      jti: 'jti-exp',
      iat: now - 120,
      exp: now - 60,
    }) as string
    expect(verifyIdentityRevocationJwt(expired, deps)).toEqual({
      ok: false,
      reason: 'expired',
    })
    const longLived = createSigner({
      key: SECRET,
      algorithm: IDENTITY_REVOCATION_ALGORITHM,
      expiresIn: 61_000,
    })({ iss: 'workos', sub: 'user_abc', aud: AUD, jti: 'jti-long' }) as string
    expect(verifyIdentityRevocationJwt(longLived, deps)).toEqual({
      ok: false,
      reason: 'ttl_exceeded',
    })
  })

  it('rejects alg other than HS256 with the same class as a bad signature', () => {
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: 'workos',
      sub: 'user_abc',
      aud: AUD,
      jti: 'jti-alg',
      iat: now,
      exp: now + 60,
    }
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      '',
    ].join('.')
    expect(verifyIdentityRevocationJwt(unsigned, deps)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })

    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const rs256 = createSigner({
      key: privateKey,
      algorithm: 'RS256',
      expiresIn: 60_000,
    })({
      iss: 'workos',
      sub: 'user_abc',
      aud: AUD,
      jti: 'jti-rs',
    }) as string
    expect(verifyIdentityRevocationJwt(rs256, deps)).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })
  })

  it('rejects missing claims', () => {
    const token = createSigner({
      key: SECRET,
      algorithm: IDENTITY_REVOCATION_ALGORITHM,
      expiresIn: 60_000,
    })({ aud: AUD, jti: 'jti-1' }) as string
    expect(verifyIdentityRevocationJwt(token, deps)).toEqual({
      ok: false,
      reason: 'missing_claim',
    })
  })
})

describe('bearerTokenFromAuthorization', () => {
  it('reads a Bearer token and ignores a missing or non-bearer header', () => {
    expect(bearerTokenFromAuthorization('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerTokenFromAuthorization('bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerTokenFromAuthorization(undefined)).toBeNull()
    expect(bearerTokenFromAuthorization('Basic abc')).toBeNull()
  })
})
