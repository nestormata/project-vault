import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  byteLength,
  isPlainObject,
  readStringClaim,
  resolveEd25519Key,
  verifyEdDsaJws,
  type JwsProfile,
} from './eddsa-jws-core.js'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function mint(header: Record<string, unknown>, payloadText = '{"a":1}'): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(payloadText)}`
  return `${signingInput}.${b64url(cryptoSign(null, Buffer.from(signingInput), privateKey))}`
}

const goodHeader = { alg: 'EdDSA', typ: 'test+jwt', kid: 'k1' }

function profile(over: Partial<JwsProfile> = {}): JwsProfile {
  return {
    expectedTyp: 'test+jwt',
    maxTokenBytes: 1024,
    maxKidLength: 8,
    resolveKey: (kid) => resolveEd25519Key([{ kid: 'k1', publicKeyPem }], kid),
    ...over,
  }
}

describe('verifyEdDsaJws', () => {
  it('verifies a valid token and returns kid + decoded payload', () => {
    expect(verifyEdDsaJws(mint(goodHeader), profile())).toEqual({
      ok: true,
      kid: 'k1',
      payload: { a: 1 },
    })
  })

  it('non-string and over-size tokens are oversized; the size boundary is inclusive', () => {
    expect(verifyEdDsaJws(undefined, profile())).toEqual({ ok: false, reason: 'oversized' })
    expect(verifyEdDsaJws({}, profile())).toEqual({ ok: false, reason: 'oversized' })
    expect(verifyEdDsaJws('a'.repeat(1025), profile())).toEqual({ ok: false, reason: 'oversized' })
    expect(verifyEdDsaJws('a'.repeat(1024), profile())).toEqual({ ok: false, reason: 'malformed' })
  })

  it('applies the header checks in order typ -> enc -> alg -> kid', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...goodHeader, typ: 'JWT', alg: 'none', kid: 'zz' }, 'malformed'],
      [{ ...goodHeader, enc: 'x', alg: 'none' }, 'malformed'],
      [{ ...goodHeader, alg: 'none', kid: 'zz' }, 'unexpected_alg'],
      [{ ...goodHeader, alg: 'eddsa' }, 'unexpected_alg'],
      [{ ...goodHeader, kid: 7 }, 'unknown_kid'],
      [{ ...goodHeader, kid: '' }, 'unknown_kid'],
      [{ ...goodHeader, kid: 'k'.repeat(9) }, 'unknown_kid'],
      [{ ...goodHeader, kid: 'zz' }, 'unknown_kid'],
    ]
    for (const [header, reason] of cases) {
      expect(verifyEdDsaJws(mint(header), profile())).toEqual({ ok: false, reason })
    }
  })

  it('selects exactly one key by kid and never consults the resolver before the header passes', () => {
    const resolveKey = vi.fn(profile().resolveKey)
    verifyEdDsaJws(mint({ ...goodHeader, typ: 'other' }), profile({ resolveKey }))
    verifyEdDsaJws(mint({ ...goodHeader, alg: 'HS256' }), profile({ resolveKey }))
    expect(resolveKey).not.toHaveBeenCalled()
    verifyEdDsaJws(mint(goodHeader), profile({ resolveKey }))
    expect(resolveKey).toHaveBeenCalledTimes(1)
    expect(resolveKey).toHaveBeenCalledWith('k1')
  })

  it('a forged signature over a garbage payload is signature_invalid, not malformed', () => {
    const token = `${b64url(JSON.stringify(goodHeader))}.${b64url('not json')}.${b64url('sig')}`
    expect(verifyEdDsaJws(token, profile())).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('a valid signature over a non-JSON payload is malformed (after the signature)', () => {
    expect(verifyEdDsaJws(mint(goodHeader, 'not json'), profile())).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('a valid signature over a JSON null payload returns it for the caller to reject', () => {
    expect(verifyEdDsaJws(mint(goodHeader, 'null'), profile())).toEqual({
      ok: true,
      kid: 'k1',
      payload: null,
    })
  })

  it('a verify function that throws is signature_invalid and the injected verifyFn is used', () => {
    const verifyFn = vi.fn(() => {
      throw new Error('boom')
    })
    expect(verifyEdDsaJws(mint(goodHeader), profile({ verifyFn }))).toEqual({
      ok: false,
      reason: 'signature_invalid',
    })
    expect(verifyFn).toHaveBeenCalledTimes(1)
  })

  it('never throws for odd structures', () => {
    for (const token of ['', '..', 'a.b', 'a.b.c.d', '\ud800', '\ud800.\udc00.x']) {
      expect(verifyEdDsaJws(token, profile()).ok).toBe(false)
    }
    for (const text of ['[]', 'null', '5', '"x"']) {
      const token = `${b64url(text)}.${b64url('{}')}.${b64url('s')}`
      expect(verifyEdDsaJws(token, profile())).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  it('never throws for 200 random strings and byte-mutated tokens', () => {
    const base = Buffer.from(mint(goodHeader))
    for (let i = 0; i < 100; i++) {
      const random = randomBytes(1 + (i % 60)).toString(i % 2 ? 'base64url' : 'latin1')
      expect(() => verifyEdDsaJws(random, profile())).not.toThrow()
      const mutated = Buffer.from(base)
      mutated[i % mutated.length] = (mutated.readUInt8(i % mutated.length) ^ (1 + (i % 200))) & 0xff
      const result = verifyEdDsaJws(mutated.toString('latin1'), profile())
      expect(result.ok).toBe(false)
    }
  })
})

describe('resolveEd25519Key', () => {
  it('returns undefined for unknown kids, prototype names, RSA keys and garbage PEM', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'pem', type: 'spki' })
      .toString()
    const keys = [
      { kid: 'k1', publicKeyPem },
      { kid: 'rsa', publicKeyPem: rsa },
      { kid: 'bad', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' },
    ]
    expect((resolveEd25519Key(keys, 'k1') as KeyObject).asymmetricKeyType).toBe('ed25519')
    for (const kid of ['nope', '__proto__', 'constructor', 'toString', 'rsa', 'bad']) {
      expect(resolveEd25519Key(keys, kid)).toBeUndefined()
    }
  })
})

describe('claim helpers', () => {
  it('readStringClaim distinguishes missing from malformed and counts bytes', () => {
    const p = { a: 'x', b: '', c: 5, d: null, e: 'é'.repeat(3) }
    expect(readStringClaim(p, 'a', 4)).toEqual({ ok: true, value: 'x' })
    expect(readStringClaim(p, 'zz', 4)).toEqual({ ok: false, kind: 'missing' })
    expect(readStringClaim(p, 'd', 4)).toEqual({ ok: false, kind: 'missing' })
    expect(readStringClaim(p, 'b', 4)).toEqual({ ok: false, kind: 'malformed' })
    expect(readStringClaim(p, 'c', 4)).toEqual({ ok: false, kind: 'malformed' })
    expect(readStringClaim(p, 'e', 5)).toEqual({ ok: false, kind: 'malformed' })
    expect(byteLength('é')).toBe(2)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject({})).toBe(true)
  })
})
