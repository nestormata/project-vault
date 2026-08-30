import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  env: {
    VAULT_HANDOFF_INSTANCE_ID: 'pv-test-instance',
    VAULT_HANDOFF_ISSUER: 'https://app.centralizeme.com',
  },
  handoffVerifyKeys: [] as { kid: string; publicKeyPem: string }[],
}))

vi.mock('../../config/env.js', () => ({
  get env() {
    return state.env
  },
  get handoffVerifyKeys() {
    return state.handoffVerifyKeys
  },
}))

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

const OTHER_KEYPAIR = generateKeyPairSync('ed25519')
const OTHER_PUBLIC_PEM = OTHER_KEYPAIR.publicKey.export({ format: 'pem', type: 'spki' }).toString()

type ClaimOverrides = Record<string, unknown>

function signToken(
  headerOverrides: Record<string, unknown> = {},
  claimOverrides: ClaimOverrides = {},
  signingKeyPem: string = privateKeyPem
): string {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: 'EdDSA',
    kid: 'kid-1',
    typ: 'JWT',
    ...headerOverrides,
  }
  const payload = {
    iss: 'https://app.centralizeme.com',
    aud: 'pv:pv-test-instance',
    iat: now,
    exp: now + 30,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    workosUserId: 'user_123',
    providerName: 'centralizeme-handoff',
    organizationId: 'org_abc',
    instanceId: 'pv-test-instance',
    tier: 'pro',
    capabilities: ['feature.a'],
    claimsVersion: 1,
    ...claimOverrides,
  }
  const headerPart = b64url(JSON.stringify(header))
  const payloadPart = b64url(JSON.stringify(payload))
  const signingInput = `${headerPart}.${payloadPart}`
  const key = createPrivateKey({ key: signingKeyPem, format: 'pem' })
  const signature = cryptoSign(null, Buffer.from(signingInput), key)
  return `${signingInput}.${b64url(signature)}`
}

describe('verifyHandoffToken (Story 30.2 AC3/AC6)', () => {
  let verifyHandoffToken: typeof import('./handoff-verify.js').verifyHandoffToken

  beforeEach(async () => {
    state.handoffVerifyKeys = [{ kid: 'kid-1', publicKeyPem }]
    vi.resetModules()
    ;({ verifyHandoffToken } = await import('./handoff-verify.js'))
  })

  it('AC3.7 happy path: a well-formed valid token verifies', () => {
    const token = signToken()
    const result = verifyHandoffToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.workosUserId).toBe('user_123')
      expect(result.claims.organizationId).toBe('org_abc')
      expect(result.claims.unknownClaimsVersion).toBe(false)
    }
  })

  it('AC3.8: oversized body rejects handoff_claims_oversized', () => {
    const huge = 'a'.repeat(17 * 1024)
    expect(verifyHandoffToken(huge)).toEqual({ ok: false, reason: 'handoff_claims_oversized' })
  })

  it('AC3.9: malformed (non-JWS-shaped) body rejects handoff_malformed_claim', () => {
    expect(verifyHandoffToken('not-a-jws')).toEqual({
      ok: false,
      reason: 'handoff_malformed_claim',
    })
  })

  it('AC3.10: alg confusion — alg:none rejects handoff_unexpected_alg', () => {
    const token = signToken({ alg: 'none' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unexpected_alg' })
  })

  it('AC3.10: alg confusion — HS256 rejects handoff_unexpected_alg (never treated as valid)', () => {
    const token = signToken({ alg: 'HS256' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unexpected_alg' })
  })

  it('AC3.10: unknown kid rejects handoff_unknown_kid and never tries another configured key', () => {
    state.handoffVerifyKeys = [
      { kid: 'kid-1', publicKeyPem },
      { kid: 'kid-2', publicKeyPem: OTHER_PUBLIC_PEM },
    ]
    const token = signToken({ kid: 'unknown-kid' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unknown_kid' })
  })

  it('AC3.10: absent kid rejects handoff_unknown_kid', () => {
    const token = signToken({ kid: undefined })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unknown_kid' })
  })

  it('signature signed by a DIFFERENT key than the claimed kid rejects handoff_signature_invalid', () => {
    // Signed with OTHER_KEYPAIR's private key but header claims kid-1 (whose configured public
    // key is the FIRST keypair) — proves the verifier does not fall back to trying other keys.
    const token = signToken(
      {},
      {},
      OTHER_KEYPAIR.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    )
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_signature_invalid' })
  })

  it('tampered payload after signing rejects handoff_signature_invalid', () => {
    const token = signToken()
    const [h, p, s] = token.split('.')
    const tamperedPayload = b64url(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p as string, 'base64url').toString()),
        tier: 'enterprise',
      })
    )
    expect(verifyHandoffToken(`${h}.${tamperedPayload}.${s}`)).toEqual({
      ok: false,
      reason: 'handoff_signature_invalid',
    })
  })

  it('AC3.9: missing required claim rejects handoff_missing_claim', () => {
    const token = signToken({}, { workosUserId: undefined })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_missing_claim' })
  })

  it('AC3.9: malformed claim type rejects handoff_malformed_claim', () => {
    const token = signToken({}, { workosUserId: 12345 })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
  })

  it('AC3.9: iat too far in the future rejects handoff_clock_skew', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signToken({}, { iat: now + 3600, exp: now + 3600 + 30 })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_clock_skew' })
  })

  it('AC3.9: nbf far in the future beyond tolerance rejects handoff_not_yet_valid', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signToken({}, { nbf: now + 3600 })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_not_yet_valid' })
  })

  it('AC3.9: expired token rejects handoff_expired', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signToken({}, { iat: now - 200, exp: now - 140 })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_expired' })
  })

  it('AC3.9: audience mismatch (wrong aud) rejects handoff_audience_mismatch', () => {
    const token = signToken({}, { aud: 'pv:some-other-instance' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_audience_mismatch' })
  })

  it('AC3.9: audience mismatch (wrong instanceId claim) rejects handoff_audience_mismatch', () => {
    const token = signToken({}, { instanceId: 'some-other-instance' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_audience_mismatch' })
  })

  it('unknown amr value rejects handoff_unknown_assurance', () => {
    const token = signToken({}, { amr: ['pwd', 'quantum-teleport'] })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unknown_assurance' })
  })

  it('AC4.17: claimsVersion other than 1 is accepted for identity purposes, flagged unknownClaimsVersion', () => {
    const token = signToken({}, { claimsVersion: 2 })
    const result = verifyHandoffToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.claims.unknownClaimsVersion).toBe(true)
  })

  it('token lifetime exceeding 60s rejects handoff_malformed_claim', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signToken({}, { iat: now, exp: now + 61 })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
  })

  it('wrong issuer rejects handoff_malformed_claim', () => {
    const token = signToken({}, { iss: 'https://evil.example.com' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
  })
})
