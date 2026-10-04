import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Story 71.6 AC-1.4: pins the ORDER of the handoff rejection matrix on tokens that fail in two
// ways at once. Written and run against the pre-refactor verifier, then re-run after the shared
// EdDSA-JWS core extraction: the matrix must be identical.

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

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function validPayload(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://app.centralizeme.com',
    aud: 'pv:pv-test-instance',
    iat: now,
    exp: now + 30,
    jti: 'jti-char-1',
    workosUserId: 'user_123',
    providerName: 'centralizeme-handoff',
    organizationId: 'org_abc',
    instanceId: 'pv-test-instance',
    tier: 'pro',
    capabilities: ['feature.a'],
    claimsVersion: 1,
  }
}

function mint(header: Record<string, unknown>, payloadText?: string): string {
  const headerPart = b64url(JSON.stringify(header))
  const payloadPart = b64url(payloadText ?? JSON.stringify(validPayload()))
  const signingInput = `${headerPart}.${payloadPart}`
  return `${signingInput}.${b64url(cryptoSign(null, Buffer.from(signingInput), privateKey))}`
}

const goodHeader = { alg: 'EdDSA', typ: 'JWT', kid: 'kid-1' }

describe('handoff verifier matrix ORDER (characterization, Story 71.6 AC-1.4)', () => {
  let verifyHandoffToken: typeof import('./handoff-verify.js').verifyHandoffToken

  beforeEach(async () => {
    state.handoffVerifyKeys = [{ kid: 'kid-1', publicKeyPem }]
    vi.resetModules()
    ;({ verifyHandoffToken } = await import('./handoff-verify.js'))
  })

  it('happy path verifies', () => {
    expect(verifyHandoffToken(mint(goodHeader)).ok).toBe(true)
  })

  it('wrong typ AND unknown kid -> malformed_claim (typ precedes key lookup)', () => {
    const token = mint({ ...goodHeader, typ: 'pv-delegation+jwt', kid: 'nope' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
  })

  it('enc present AND unknown kid -> malformed_claim', () => {
    const token = mint({ ...goodHeader, enc: 'A128GCM', kid: 'nope' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
  })

  it('wrong typ AND wrong alg -> malformed_claim (typ precedes alg)', () => {
    const token = mint({ ...goodHeader, typ: 'x', alg: 'HS256' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
  })

  it('unexpected alg AND unknown kid -> unexpected_alg (alg precedes key lookup)', () => {
    const token = mint({ ...goodHeader, alg: 'none', kid: 'nope' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unexpected_alg' })
  })

  it('unexpected alg AND absent kid -> unexpected_alg', () => {
    const token = mint({ typ: 'JWT', alg: 'HS256' })
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_unexpected_alg' })
  })

  it('oversized beats malformed structure', () => {
    expect(verifyHandoffToken('.'.repeat(16 * 1024 + 1))).toEqual({
      ok: false,
      reason: 'handoff_claims_oversized',
    })
  })

  it('exactly 16 KiB of malformed text -> malformed_claim (size boundary is inclusive)', () => {
    expect(verifyHandoffToken('a'.repeat(16 * 1024))).toEqual({
      ok: false,
      reason: 'handoff_malformed_claim',
    })
  })

  it('valid signature but non-JSON payload -> malformed_claim only AFTER signature', () => {
    expect(verifyHandoffToken(mint(goodHeader, 'not json'))).toEqual({
      ok: false,
      reason: 'handoff_malformed_claim',
    })
  })

  it('forged signature AND garbage payload -> signature_invalid (not malformed)', () => {
    const headerPart = b64url(JSON.stringify(goodHeader))
    const token = `${headerPart}.${b64url('not json')}.${b64url('forged-signature')}`
    expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_signature_invalid' })
  })

  it('valid signature, payload JSON array -> malformed_claim', () => {
    expect(verifyHandoffToken(mint(goodHeader, '[1]'))).toEqual({
      ok: false,
      reason: 'handoff_malformed_claim',
    })
  })

  it.each([[''], ['..'], ['a.b'], ['a.b.c.d']])('structure %j never throws', (token) => {
    expect(verifyHandoffToken(token).ok).toBe(false)
  })

  it('header that is a JSON array / null / number -> malformed_claim', () => {
    for (const text of ['[]', 'null', '5']) {
      const token = `${b64url(text)}.${b64url('{}')}.${b64url('sig')}`
      expect(verifyHandoffToken(token)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
    }
  })

  it('kid of 129 chars -> unknown_kid; 128 chars with no key -> unknown_kid', () => {
    for (const kid of ['k'.repeat(129), 'k'.repeat(128)]) {
      expect(verifyHandoffToken(mint({ ...goodHeader, kid }))).toEqual({
        ok: false,
        reason: 'handoff_unknown_kid',
      })
    }
  })
})
