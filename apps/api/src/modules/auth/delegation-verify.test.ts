import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  createPrivateKey,
  verify as cryptoVerify,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  env: {
    VAULT_HANDOFF_INSTANCE_ID: 'pv-test-instance' as string | undefined,
    VAULT_HANDOFF_ISSUER: 'https://app.centralizeme.com',
  },
  delegationVerifyKeys: [] as { kid: string; publicKeyPem: string }[],
  handoffVerifyKeys: [] as { kid: string; publicKeyPem: string }[],
}))

vi.mock('../../config/env.js', () => ({
  get env() {
    return state.env
  },
  get delegationVerifyKeys() {
    return state.delegationVerifyKeys
  },
  get handoffVerifyKeys() {
    return state.handoffVerifyKeys
  },
}))

import {
  DELEGATION_HOST_OUTCOMES,
  DELEGATION_OUTCOMES,
  DELEGATION_REASON_TO_OUTCOME,
  DELEGATION_REJECT_REASONS,
  createDelegationVerifier,
  isPreSignatureRejection,
  verifyDelegationAssertion,
  type DelegationRejectReason,
} from './delegation-verify.js'
import { verifyHandoffToken } from './handoff-verify.js'
import type { VerifyFn } from './eddsa-jws-core.js'

function spyVerify() {
  return vi.fn<VerifyFn>((algorithm, data, key, signature) =>
    cryptoVerify(algorithm, data, key, signature)
  )
}

const NOW_S = 1_790_000_000
const NOW_MS = NOW_S * 1000
const ISSUER = 'https://app.centralizeme.com'
const INSTANCE = 'pv-test-instance'

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}
function pemPair(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
}

const deleg = pemPair()
const deleg2 = pemPair()
const handoff = pemPair()
const KID = 'deleg-test-1'
const KID2 = 'deleg-test-2'
const HANDOFF_KID = 'handoff-kid'
const KEYS = [{ kid: KID, publicKeyPem: deleg.publicPem }]
const BSH = createHash('sha256').update('{"x":1}').digest('base64url')

type Bag = Record<string, unknown>

function claims(over: Bag = {}, nowS = NOW_S): Bag {
  return {
    ver: 1,
    iss: ISSUER,
    aud: `pvd:${INSTANCE}`,
    iat: nowS,
    exp: nowS + 45,
    jti: 'jti-0001',
    org: 'org_cm_abc',
    act: { prv: 'centralizeme-handoff', sub: 'user_01TEST' },
    op: 'POST /api/v1/cm/audit-events',
    bsh: BSH,
    ...over,
  }
}

function sign(
  headerOver: Bag = {},
  claimOver: Bag = {},
  signingPem: string = deleg.privatePem,
  rawPayload?: string
): string {
  const header = { alg: 'EdDSA', typ: 'pv-delegation+jwt', kid: KID, ...headerOver }
  const headerPart = b64url(JSON.stringify(header))
  const payloadPart = b64url(rawPayload ?? JSON.stringify(claims(claimOver)))
  const input = `${headerPart}.${payloadPart}`
  const sig = cryptoSign(null, Buffer.from(input), createPrivateKey(signingPem))
  return `${input}.${b64url(sig)}`
}

function verifier(over: Parameters<typeof createDelegationVerifier>[0] = {}) {
  return createDelegationVerifier({
    now: () => NOW_MS,
    keys: KEYS,
    instanceId: INSTANCE,
    issuer: ISSUER,
    ...over,
  })
}

function expectReject(token: unknown, reason: DelegationRejectReason, v = verifier()): void {
  expect(v(token)).toEqual({ ok: false, reason })
}

describe('AC-2 happy paths', () => {
  it('H1: verifies a valid assertion and returns exactly the frozen D8 shape', () => {
    const result = verifier()(sign())
    expect(result).toEqual({
      ok: true,
      claims: {
        version: 1,
        kid: KID,
        issuer: ISSUER,
        audience: `pvd:${INSTANCE}`,
        issuedAt: NOW_S,
        expiresAt: NOW_S + 45,
        jti: 'jti-0001',
        org: 'org_cm_abc',
        actor: { provider: 'centralizeme-handoff', subject: 'user_01TEST' },
        operation: 'POST /api/v1/cm/audit-events',
        bodyHash: BSH,
      },
    })
    if (!result.ok) throw new Error('unreachable')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.claims)).toBe(true)
    expect(Object.isFrozen(result.claims.actor)).toBe(true)
  })

  it('H2/H3: boundary lifetime 60 s and inclusive skew edges verify', () => {
    expect(verifier()(sign({}, { exp: NOW_S + 60 })).ok).toBe(true)
    expect(verifier()(sign({}, { iat: NOW_S + 30, exp: NOW_S + 60 })).ok).toBe(true)
    expect(verifier()(sign({}, { iat: NOW_S - 75, exp: NOW_S - 30 })).ok).toBe(true)
  })

  it('H4: unknown claims, nbf, occ, amr and capabilities are ignored and never returned', () => {
    const result = verifier()(
      sign({}, { foo: 1, nbf: NOW_S + 1000, occ: { x: 1 }, amr: ['mfa'], capabilities: ['all'] })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.claims).sort()).toEqual(
      [
        'actor',
        'audience',
        'bodyHash',
        'expiresAt',
        'issuedAt',
        'issuer',
        'jti',
        'kid',
        'operation',
        'org',
        'version',
      ].sort()
    )
  })

  it('H5: with two keys, a token signed by the second verifies with the second kid', () => {
    const keys = [...KEYS, { kid: KID2, publicKeyPem: deleg2.publicPem }]
    const result = verifier({ keys })(sign({ kid: KID2 }, {}, deleg2.privatePem))
    expect(result.ok && result.claims.kid).toBe(KID2)
  })

  it('the exported default verifier reads the live env and key set', () => {
    state.delegationVerifyKeys = KEYS
    const now = Math.floor(Date.now() / 1000)
    expect(
      verifyDelegationAssertion(sign({}, {}, deleg.privatePem, JSON.stringify(claims({}, now)))).ok
    ).toBe(true)
    state.delegationVerifyKeys = []
    expectReject(sign(), 'delegation_not_configured', verifyDelegationAssertion)
  })

  it('the verifier is stateless: the same token verifies twice (replay is 71-7)', () => {
    const v = verifier()
    const token = sign()
    expect(v(token).ok).toBe(true)
    expect(v(token).ok).toBe(true)
  })
})

describe('AC-2 rejections, pre-signature', () => {
  it('R1/R2: not configured is returned before any crypto, even for garbage', () => {
    const verifyFn = spyVerify()
    expectReject('garbage', 'delegation_not_configured', verifier({ keys: [], verifyFn }))
    expectReject(sign(), 'delegation_not_configured', verifier({ instanceId: undefined, verifyFn }))
    expectReject(undefined, 'delegation_not_configured', verifier({ keys: [], verifyFn }))
    expect(verifyFn).not.toHaveBeenCalled()
  })

  it('R3/R4: size cap is 8 KiB, inclusive; non-strings are oversized', () => {
    expectReject('a'.repeat(8 * 1024 + 1), 'delegation_oversized')
    expectReject('a'.repeat(8 * 1024), 'delegation_malformed')
    for (const bad of [undefined, 5, {}, null]) expectReject(bad, 'delegation_oversized')
  })

  it('R5: only the exact typ is accepted', () => {
    for (const typ of [
      'JWT',
      undefined,
      'pv-delegation',
      'PV-DELEGATION+JWT',
      'pv-delegation+jwt ',
    ]) {
      expectReject(sign({ typ }), 'delegation_malformed')
    }
  })

  it('R6: enc present is malformed', () => {
    expectReject(sign({ enc: 'A256GCM' }), 'delegation_malformed')
  })

  it('R7: only EdDSA is accepted', () => {
    for (const alg of ['none', 'HS256', 'RS256', 'ES256', 'eddsa', undefined]) {
      expectReject(sign({ alg }), 'delegation_unexpected_alg')
    }
  })

  it('R8: bad, unknown or handoff kids are unknown_kid', () => {
    state.handoffVerifyKeys = [{ kid: HANDOFF_KID, publicKeyPem: handoff.publicPem }]
    for (const kid of [undefined, '', 'k'.repeat(129), 7, [KID], 'nope', HANDOFF_KID]) {
      expectReject(sign({ kid }), 'delegation_unknown_kid')
    }
  })

  it('R8: exactly one key is consulted by exact kid (no scan)', () => {
    const verifyFn = spyVerify()
    const keys = Array.from({ length: 50 }, (_, i) => ({
      kid: `k${i}`,
      publicKeyPem: i === 49 ? deleg.publicPem : deleg2.publicPem,
    }))
    expect(verifier({ keys, verifyFn })(sign({ kid: 'k49' })).ok).toBe(true)
    expect(verifyFn).toHaveBeenCalledTimes(1)
    expectReject(sign({ kid: 'k99' }), 'delegation_unknown_kid', verifier({ keys, verifyFn }))
    expect(verifyFn).toHaveBeenCalledTimes(1)
  })

  it('R9: a non-Ed25519 key in the set is refused at request time', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'pem', type: 'spki' })
      .toString()
    const keys = [{ kid: 'rsa-kid', publicKeyPem: rsa }]
    expectReject(sign({ kid: 'rsa-kid' }), 'delegation_unknown_kid', verifier({ keys }))
  })

  it('R9/AC-7.3: a PEM-shaped but invalid key maps to unknown_kid without throwing', () => {
    const keys = [
      {
        kid: 'bad',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAAAAAAAAAA\n-----END PUBLIC KEY-----',
      },
    ]
    expectReject(sign({ kid: 'bad' }), 'delegation_unknown_kid', verifier({ keys }))
  })

  it('R9b: prototype-pollution kids never match; a legitimate "constructor" kid verifies', () => {
    for (const kid of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '__defineGetter__',
    ]) {
      expectReject(sign({ kid }), 'delegation_unknown_kid')
    }
    const keys = [{ kid: 'constructor', publicKeyPem: deleg.publicPem }]
    expect(verifier({ keys })(sign({ kid: 'constructor' })).ok).toBe(true)
  })

  it('R10: wrong key, tampered payload, truncated, empty or non-base64url signatures', () => {
    expectReject(sign({}, {}, deleg2.privatePem), 'delegation_signature_invalid')
    const [h, p, s] = sign().split('.') as [string, string, string]
    const tampered = b64url(JSON.stringify(claims({ org: 'org_other' })))
    expectReject(`${h}.${tampered}.${s}`, 'delegation_signature_invalid')
    expectReject(`${h}.${p}.${s.slice(0, 20)}`, 'delegation_signature_invalid')
    expectReject(`${h}.${p}.`, 'delegation_signature_invalid')
    expectReject(`${h}.${p}.!!!!`, 'delegation_signature_invalid')
  })

  it('AC-5.7: a random operator-style token is malformed', () => {
    expectReject(Buffer.alloc(32, 7).toString('base64'), 'delegation_malformed')
  })
})

describe('AC-2 rejections, post-signature', () => {
  it('R11: a valid signature over a non-object payload is malformed', () => {
    for (const raw of ['not json', '[1]', 'null', '"s"', '5']) {
      expectReject(sign({}, {}, deleg.privatePem, raw), 'delegation_malformed')
    }
  })

  it('R12: ver must be the integer 1', () => {
    for (const ver of [2, 0, '1', 1.5, null]) {
      expectReject(
        sign({}, { ver }),
        ver === null ? 'delegation_missing_claim' : 'delegation_malformed_claim'
      )
    }
    expectReject(sign({}, { ver: undefined }), 'delegation_missing_claim')
  })

  it('R13: iss must match exactly', () => {
    for (const iss of [
      'https://other.example',
      `${ISSUER}/`,
      'https://APP.centralizeme.com',
      [ISSUER],
    ]) {
      expectReject(sign({}, { iss }), 'delegation_malformed_claim')
    }
  })

  it.each(['iss', 'aud', 'iat', 'exp', 'jti', 'org', 'act', 'op', 'bsh'])(
    'R14: missing %s is missing_claim',
    (key) => {
      expectReject(sign({}, { [key]: undefined }), 'delegation_missing_claim')
      expectReject(sign({}, { [key]: null }), 'delegation_missing_claim')
    }
  )

  it.each(['prv', 'sub'])('R14: missing act.%s is missing_claim', (key) => {
    expectReject(
      sign({}, { act: { prv: 'p', sub: 's', [key]: undefined } }),
      'delegation_missing_claim'
    )
  })

  it('R15: wrong types are malformed_claim; empty string is malformed', () => {
    const cases: Bag[] = [
      { jti: 5 },
      { act: 'x' },
      { act: ['a'] },
      { org: '' },
      { act: { prv: 'p', sub: {} } },
      { act: { prv: 7, sub: 's' } },
      { op: false },
    ]
    for (const c of cases) expectReject(sign({}, c), 'delegation_malformed_claim')
  })

  it('R16: bounds are in UTF-8 bytes, not characters', () => {
    const cases: Bag[] = [
      { org: 'o'.repeat(129) },
      { jti: 'j'.repeat(129) },
      { op: 'p'.repeat(257) },
      { act: { prv: 'p', sub: 's'.repeat(257) } },
      { act: { prv: 'p'.repeat(257), sub: 's' } },
      { org: 'é'.repeat(65) },
    ]
    for (const c of cases) expectReject(sign({}, c), 'delegation_malformed_claim')
    expect(verifier()(sign({}, { org: 'o'.repeat(128), op: 'p'.repeat(256) })).ok).toBe(true)
  })

  it('R17: bsh must be 43 base64url characters', () => {
    const cases = [
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}/`,
      '',
    ]
    for (const bsh of cases) expectReject(sign({}, { bsh }), 'delegation_malformed_claim')
  })

  it('R18: lifetime rules and non-finite times', () => {
    for (const exp of [NOW_S, NOW_S - 5, NOW_S + 61, 'x']) {
      expectReject(sign({}, { exp }), 'delegation_malformed_claim')
    }
    expectReject(sign({}, { iat: 'NaN' }), 'delegation_malformed_claim')
    const raw = JSON.stringify(claims()).replace(`"exp":${NOW_S + 45}`, '"exp":1e999')
    expectReject(sign({}, {}, deleg.privatePem, raw), 'delegation_malformed_claim')
  })

  it('R19/R20: skew and expiry thresholds', () => {
    expectReject(sign({}, { iat: NOW_S + 31, exp: NOW_S + 60 }), 'delegation_clock_skew')
    expectReject(sign({}, { iat: NOW_S - 76, exp: NOW_S - 31 }), 'delegation_expired')
  })

  it('R22: audience namespace is exact and typed', () => {
    for (const aud of [`pv:${INSTANCE}`, 'pvd:other', `PVD:${INSTANCE}`, `pvd:${INSTANCE} `]) {
      expectReject(sign({}, { aud }), 'delegation_audience_mismatch')
    }
    expectReject(sign({}, { aud: [`pvd:${INSTANCE}`] }), 'delegation_malformed_claim')
  })

  it('R23: when several faults coexist the first in pipeline order wins', () => {
    const farFuture = { iat: NOW_S + 1000, exp: NOW_S + 1030 }
    const expired = { iat: NOW_S - 1000, exp: NOW_S - 970 }
    expectReject(sign({}, { ver: 2, ...expired, aud: 'x' }), 'delegation_malformed_claim')
    expectReject(sign({}, { ...expired, aud: 'x' }), 'delegation_expired')
    expectReject(sign({}, { ...farFuture, aud: 'x' }), 'delegation_clock_skew')
    expectReject(sign({}, { aud: 'x' }), 'delegation_audience_mismatch')
  })

  it('R9c: hostile payload keys never pollute and never leak into the result', () => {
    const raw = JSON.stringify(claims()).replace(
      '{"ver":1',
      '{"__proto__":{"org":"evil"},"constructor":{"x":1},"ver":1'
    )
    const withDup = raw.replace('"org":"org_cm_abc"', '"org":"first","org":"org_cm_abc"')
    const result = verifier()(sign({}, {}, deleg.privatePem, withDup))
    expect(({} as Record<string, unknown>)['org']).toBeUndefined()
    expect(result.ok && result.claims.org).toBe('org_cm_abc')
    const extraAct = verifier()(sign({}, { act: { prv: 'p', sub: 's', extra: 1, admin: true } }))
    expect(extraAct.ok && Object.keys(extraAct.claims.actor).sort()).toEqual([
      'provider',
      'subject',
    ])
  })

  it('R21: not_yet_valid is declared but unreachable; a future iat is clock_skew', () => {
    expect(DELEGATION_REJECT_REASONS).toContain('delegation_not_yet_valid')
    expectReject(
      sign({}, { iat: NOW_S + 31, exp: NOW_S + 60, nbf: NOW_S + 5000 }),
      'delegation_clock_skew'
    )
  })
})

describe('AC-3 classification and outcome map', () => {
  const PRE: DelegationRejectReason[] = [
    'delegation_not_configured',
    'delegation_oversized',
    'delegation_malformed',
    'delegation_unexpected_alg',
    'delegation_unknown_kid',
    'delegation_signature_invalid',
  ]
  const classification: Record<DelegationRejectReason, boolean> = {
    delegation_not_configured: true,
    delegation_oversized: true,
    delegation_malformed: true,
    delegation_unexpected_alg: true,
    delegation_unknown_kid: true,
    delegation_signature_invalid: true,
    delegation_malformed_claim: false,
    delegation_missing_claim: false,
    delegation_expired: false,
    delegation_not_yet_valid: false,
    delegation_clock_skew: false,
    delegation_audience_mismatch: false,
  }

  it('the reason array equals the classified union and isPreSignatureRejection matches', () => {
    expect([...DELEGATION_REJECT_REASONS].sort()).toEqual(Object.keys(classification).sort())
    for (const reason of DELEGATION_REJECT_REASONS) {
      expect(isPreSignatureRejection(reason)).toBe(PRE.includes(reason))
    }
    expect(DELEGATION_REJECT_REASONS.filter(isPreSignatureRejection)).toEqual(PRE)
  })

  it('a forged token never learns time or audience: only pre-signature reasons', () => {
    const bad: Bag[] = [
      { iat: NOW_S - 1000, exp: NOW_S - 970 },
      { aud: 'wrong' },
      { iat: NOW_S + 1000, exp: NOW_S + 1030 },
      { ver: 9 },
      { org: undefined },
      {},
    ]
    for (const over of bad) {
      const forged = sign({}, over, deleg2.privatePem)
      const result = verifier()(forged)
      expect(result).toEqual({ ok: false, reason: 'delegation_signature_invalid' })
    }
    for (let i = 0; i < 4; i++) {
      const r = verifier()(`${sign().slice(0, -4)}AAAA`)
      expect(r.ok === false && isPreSignatureRejection(r.reason)).toBe(true)
    }
  })

  it('the outcome map is exhaustive, bounded and folds missing_claim', () => {
    const outcomes = new Set([
      'not_configured',
      'oversized',
      'malformed',
      'unexpected_alg',
      'unknown_kid',
      'signature_invalid',
      'malformed_claim',
      'expired',
      'not_yet_valid',
      'clock_skew',
      'audience_mismatch',
    ])
    expect(Object.keys(DELEGATION_REASON_TO_OUTCOME).sort()).toEqual(
      [...DELEGATION_REJECT_REASONS].sort()
    )
    for (const value of Object.values(DELEGATION_REASON_TO_OUTCOME)) {
      expect(outcomes.has(value)).toBe(true)
    }
    expect(DELEGATION_REASON_TO_OUTCOME.delegation_missing_claim).toBe('malformed_claim')
    expect(DELEGATION_REASON_TO_OUTCOME.delegation_malformed_claim).toBe('malformed_claim')
    expect(Object.isFrozen(DELEGATION_REASON_TO_OUTCOME)).toBe(true)
  })
})

describe('Story 71.3 AC-8 closed counter outcome set', () => {
  it('adds the host-decided outcomes next to the verifier mapping with no duplicates', () => {
    const verifierOutcomes = new Set(Object.values(DELEGATION_REASON_TO_OUTCOME))
    for (const outcome of DELEGATION_HOST_OUTCOMES)
      expect(verifierOutcomes.has(outcome)).toBe(false)
    expect(new Set(DELEGATION_OUTCOMES).size).toBe(DELEGATION_OUTCOMES.length)
    expect(DELEGATION_OUTCOMES).toEqual(
      expect.arrayContaining([
        'missing',
        'rate_limited_pre',
        'operation_mismatch',
        'body_mismatch',
        'subject_mismatch',
        'org_not_served',
        'replayed',
        'store_unavailable',
        'actor_not_member',
        'actor_unlinked',
        'actor_attested_nonmember',
      ])
    )
    expect(Object.isFrozen(DELEGATION_OUTCOMES)).toBe(true)
  })
})

describe('AC-5 key-purpose confusion', () => {
  beforeEach(() => {
    state.delegationVerifyKeys = KEYS
    state.handoffVerifyKeys = [{ kid: HANDOFF_KID, publicKeyPem: handoff.publicPem }]
  })

  function loginToken(headerOver: Bag = {}, claimOver: Bag = {}): string {
    const header = { alg: 'EdDSA', typ: 'JWT', kid: HANDOFF_KID, ...headerOver }
    const payload = {
      iss: ISSUER,
      aud: `pv:${INSTANCE}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
      jti: 'jti-login',
      workosUserId: 'u',
      providerName: 'p',
      organizationId: 'o',
      instanceId: INSTANCE,
      tier: 't',
      capabilities: [],
      claimsVersion: 1,
      ...claimOver,
    }
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
    return `${input}.${b64url(cryptoSign(null, Buffer.from(input), createPrivateKey(handoff.privatePem)))}`
  }

  it('1: a valid login token is malformed as an assertion, before key lookup', () => {
    expect(verifyHandoffToken(loginToken()).ok).toBe(true)
    const find = vi.fn(Array.prototype.find)
    const keys = Object.assign([...KEYS], { find })
    expectReject(loginToken(), 'delegation_malformed', verifier({ keys }))
    expect(find).not.toHaveBeenCalled()
  })

  it('2: a valid assertion is malformed as a login token, before key lookup', () => {
    const find = vi.fn(Array.prototype.find)
    state.handoffVerifyKeys = Object.assign([...state.handoffVerifyKeys], { find })
    const nowToken = sign(
      {},
      {},
      deleg.privatePem,
      JSON.stringify(claims({}, Math.floor(Date.now() / 1000)))
    )
    expect(verifyDelegationAssertion(nowToken).ok).toBe(true)
    expect(verifyHandoffToken(nowToken)).toEqual({ ok: false, reason: 'handoff_malformed_claim' })
    expect(find).not.toHaveBeenCalled()
  })

  it('3/4: the handoff key under a delegation label fails by kid or by signature', () => {
    const forged = (kid: string) => sign({ kid }, {}, handoff.privatePem)
    expectReject(forged(HANDOFF_KID), 'delegation_unknown_kid')
    expectReject(forged(KID), 'delegation_signature_invalid')
  })

  it('5: audience namespaces do not cross', () => {
    expectReject(sign({}, { aud: `pv:${INSTANCE}` }), 'delegation_audience_mismatch')
    expect(verifyHandoffToken(loginToken({}, { aud: `pvd:${INSTANCE}` }))).toEqual({
      ok: false,
      reason: 'handoff_audience_mismatch',
    })
  })
})

describe('AC-6/7/8 and cross-cutting properties', () => {
  it('AC-6.3: 1000 interleaved verifications return independent correct results', async () => {
    const v = verifier()
    const good = sign()
    const bad = sign({}, { aud: 'x' })
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => Promise.resolve().then(() => v(i % 2 ? good : bad)))
    )
    results.forEach((r, i) => expect(r.ok).toBe(i % 2 === 1))
  })

  it('AC-7.4: failure results never carry token-derived text', () => {
    const sentinel = 'SENTINEL_SUBJECT_123'
    const tokens = [
      sign({}, { act: { prv: 'p', sub: sentinel }, aud: 'x' }),
      sign({}, { act: { prv: 'p', sub: sentinel }, ver: 2 }),
      sign({}, { act: { prv: 'p', sub: sentinel } }, deleg2.privatePem),
    ]
    for (const t of tokens) {
      const r = verifier()(t)
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain(sentinel)
      expect(JSON.stringify(r)).not.toContain(KID)
      expect(Object.keys(r)).toEqual(['ok', 'reason'])
    }
  })

  it('AC-8.1: stateless rejections do no signature work', () => {
    const verifyFn = spyVerify()
    const v = verifier({ verifyFn })
    v('a'.repeat(9 * 1024))
    v('a.b')
    v(sign({ typ: 'JWT' }))
    v(sign({ alg: 'none' }))
    v(sign({ kid: 'nope' }))
    expect(verifyFn).not.toHaveBeenCalled()
  })

  it('tenant: org is returned raw and is signature-bound', () => {
    const a = verifier()(sign({}, { org: 'org_A' }))
    const b = verifier()(sign({}, { org: 'org_B' }))
    expect(a.ok && a.claims.org).toBe('org_A')
    expect(b.ok && b.claims.org).toBe('org_B')
    const [h, , s] = sign({}, { org: 'org_A' }).split('.') as [string, string, string]
    const swapped = b64url(JSON.stringify(claims({ org: 'org_B' })))
    expectReject(`${h}.${swapped}.${s}`, 'delegation_signature_invalid')
  })

  it('success exposes kid and jti; failure exposes neither', () => {
    const ok = verifier()(sign())
    expect(ok.ok && [ok.claims.kid, ok.claims.jti]).toEqual([KID, 'jti-0001'])
    expect(Object.keys(verifier()(sign({ kid: 'nope' })))).toEqual(['ok', 'reason'])
  })

  it('AC-7.1: neither module imports a logger, db, session or service-provisioning code', () => {
    const forbidden =
      /operationalLog|logger|pino|drizzle|@project-vault\/db|withOrg|setRlsOrgContext|service-provisioning|sessions|authenticate|touchSessionActivity|cookie|handoffVerifyKeys|handoff-verify/i
    for (const source of [
      readFileSync('src/modules/auth/delegation-verify.ts', 'utf8'),
      readFileSync('src/modules/auth/eddsa-jws-core.ts', 'utf8'),
    ]) {
      const imports = source
        .split('\n')
        .filter((l) => /^\s*(import|\} from)/.test(l))
        .join('\n')
      expect(imports).not.toMatch(forbidden)
    }
  })
})
