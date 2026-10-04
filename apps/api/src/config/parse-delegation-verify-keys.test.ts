import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DelegationVerifyKeysError,
  parseDelegationVerifyKeys,
  validateDelegationVerifyKeys,
} from './delegation-verify-keys.js'
import { parseHandoffVerifyKeys } from './env.js'

// Story 71.6 AC-4: the delegation verification key set, pure parser/validator. Keys are minted
// in-test; nothing here resembles production key material.

function pem(type: 'ed25519' | 'rsa' | 'ec' = 'ed25519', width = 64, eol = '\n'): string {
  const pair =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : type === 'rsa'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return rewrap(pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), width, eol)
}

function rewrap(source: string, width: number, eol: string): string {
  const body = source.replace(/-----[A-Z ]+-----|\s/g, '')
  const lines: string[] = []
  for (let i = 0; i < body.length; i += width) lines.push(body.slice(i, i + width))
  return ['-----BEGIN PUBLIC KEY-----', ...lines, '-----END PUBLIC KEY-----'].join(eol) + eol
}

const set = (...entries: { kid: string; publicKeyPem: string }[]): string => JSON.stringify(entries)

function problems(raw: string | undefined, handoff?: string, instance: string | null = 'pv-test') {
  return validateDelegationVerifyKeys(raw, handoff, instance ?? undefined)
}

describe('parseDelegationVerifyKeys', () => {
  it('B1-B3: unset, empty and [] parse to an empty frozen list', () => {
    for (const raw of [undefined, '', '[]']) {
      const keys = parseDelegationVerifyKeys(raw)
      expect(keys).toEqual([])
      expect(Object.isFrozen(keys)).toBe(true)
    }
  })

  it('B4/B5: valid entries parse in order, and the list and entries are frozen (B20)', () => {
    const a = pem()
    const b = pem()
    const keys = parseDelegationVerifyKeys(
      set({ kid: 'a', publicKeyPem: a }, { kid: 'b', publicKeyPem: b })
    )
    expect(keys).toEqual([
      { kid: 'a', publicKeyPem: a },
      { kid: 'b', publicKeyPem: b },
    ])
    const mutable = keys as { kid: string; publicKeyPem: string }[]
    expect(() => mutable.push({ kid: 'z', publicKeyPem: a })).toThrow(TypeError)
    expect(() => {
      ;(keys[0] as { kid: string }).kid = 'x'
    }).toThrow(TypeError)
  })

  it('B6: shape violations throw naming the variable and never the PEM', () => {
    const good = pem()
    const bad: string[] = [
      '{nope',
      '{"a":1}',
      '[1]',
      '[{"publicKeyPem":"x"}]',
      JSON.stringify([{ kid: '', publicKeyPem: good }]),
      JSON.stringify([{ kid: 'k'.repeat(129), publicKeyPem: good }]),
      JSON.stringify([{ kid: 'a' }]),
      JSON.stringify([{ kid: 'a', publicKeyPem: 5 }]),
      JSON.stringify([{ kid: 'a', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA' }]),
      JSON.stringify([
        { kid: 'a', publicKeyPem: '-----END PUBLIC KEY-----\n-----BEGIN PUBLIC KEY-----' },
      ]),
      set({ kid: 'a', publicKeyPem: good }, { kid: 'a', publicKeyPem: pem() }),
    ]
    for (const raw of bad) {
      expect(() => parseDelegationVerifyKeys(raw)).toThrow(DelegationVerifyKeysError)
      try {
        parseDelegationVerifyKeys(raw)
      } catch (err) {
        expect((err as Error).message).toContain('VAULT_DELEGATION_VERIFY_KEYS')
        expect((err as Error).message).not.toContain(good.split('\n')[1] as string)
      }
    }
  })

  it('B7: a well-formed envelope around random base64 is rejected', () => {
    const fake =
      '-----BEGIN PUBLIC KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END PUBLIC KEY-----'
    expect(() => parseDelegationVerifyKeys(set({ kid: 'a', publicKeyPem: fake }))).toThrow(
      /must be an Ed25519 PUBLIC key/
    )
  })

  it('B8: RSA and P-256 public keys are rejected, naming the kid', () => {
    for (const type of ['rsa', 'ec'] as const) {
      expect(() =>
        parseDelegationVerifyKeys(set({ kid: 'kid-x', publicKeyPem: pem(type) }))
      ).toThrow(/kid "kid-x".*must be an Ed25519 PUBLIC key/)
    }
  })

  it('B17: a second smuggled block or trailing text is rejected', () => {
    const one = pem()
    const two = pem()
    for (const publicKeyPem of [`${one}${two}`, `${one}trailing text`, `junk\n${one}`]) {
      expect(() => parseDelegationVerifyKeys(set({ kid: 'a', publicKeyPem }))).toThrow(
        /exactly one PEM block|Ed25519 PUBLIC key/
      )
    }
  })

  it('B18: private keys pasted by mistake are rejected without echoing key text', () => {
    const priv = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString()
    const marker = priv.split('\n')[1] as string
    const both = `${priv}${pem()}`
    for (const publicKeyPem of [
      priv,
      both,
      ['-----BEGIN OPENSSH', 'PRIVATE KEY-----\nAAAA\n-----END OPENSSH', 'PRIVATE KEY-----'].join(
        ' '
      ),
    ]) {
      const raw = set({ kid: 'a', publicKeyPem })
      expect(() => parseDelegationVerifyKeys(raw)).toThrow(/Ed25519 PUBLIC key/)
      try {
        parseDelegationVerifyKeys(raw)
      } catch (err) {
        expect((err as Error).message).not.toContain(marker)
        expect((err as Error).message).not.toContain('PRIVATE')
      }
    }
  })

  it('B19: whitespace, CRLF, re-wrapped PEM and the same key under two kids are accepted', () => {
    const base = pem('ed25519', 64)
    const variants = [
      base,
      rewrap(base, 76, '\n'),
      rewrap(base, 64, '\r\n'),
      rewrap(base, 20, '\n'),
    ]
    const raw = `\n  ${set(...variants.map((publicKeyPem, i) => ({ kid: `k${i}`, publicKeyPem })))}\n`
    expect(parseDelegationVerifyKeys(raw)).toHaveLength(4)
  })
})

describe('validateDelegationVerifyKeys', () => {
  it('B4/B11/B15: a valid set with an instance id and an empty handoff set has no problems', () => {
    expect(problems(set({ kid: 'a', publicKeyPem: pem() }))).toEqual([])
    expect(problems(set({ kid: 'a', publicKeyPem: pem() }), '[]')).toEqual([])
  })

  it('B1-B3: nothing to validate when the set is unset, empty or []', () => {
    for (const raw of [undefined, '', '[]']) expect(problems(raw, undefined, null)).toEqual([])
  })

  it('B6-B8: surfaces the parse error as the single problem', () => {
    expect(problems('{nope')).toEqual(['VAULT_DELEGATION_VERIFY_KEYS must be valid JSON'])
    expect(problems(set({ kid: 'a', publicKeyPem: pem('rsa') }))).toHaveLength(1)
  })

  it('B9: a kid shared with the handoff set is rejected', () => {
    const raw = set({ kid: 'shared', publicKeyPem: pem() })
    const handoff = set({ kid: 'shared', publicKeyPem: pem() })
    const out = problems(raw, handoff)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/kid "shared".*disjoint/)
  })

  it('B10: the same key under different kids (re-wrapped, CRLF) is rejected naming both kids', () => {
    const shared = pem('ed25519', 64)
    const raw = set({ kid: 'deleg-new', publicKeyPem: rewrap(shared, 76, '\r\n') })
    const handoff = set({ kid: 'handoff-old', publicKeyPem: shared })
    const out = problems(raw, handoff)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('deleg-new')
    expect(out[0]).toContain('handoff-old')
    expect(out[0]).not.toContain(shared.split('\n')[1] as string)
  })

  it('B12: a malformed handoff set skips disjointness and adds no secondary noise', () => {
    expect(problems(set({ kid: 'a', publicKeyPem: pem() }), '{nope')).toEqual([])
  })

  it('B13: a non-empty set requires the instance id', () => {
    expect(problems(set({ kid: 'a', publicKeyPem: pem() }), undefined, null)).toEqual([
      'VAULT_DELEGATION_VERIFY_KEYS requires VAULT_HANDOFF_INSTANCE_ID (the assertion audience is pvd:<instance id>)',
    ])
  })

  it('handoff keys that cannot be parsed as public keys are ignored by the material check', () => {
    const handoff = parseHandoffVerifyKeys(
      set({ kid: 'h', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' })
    )
    expect(handoff).toHaveLength(1)
    expect(
      problems(
        set({ kid: 'a', publicKeyPem: pem() }),
        set({
          kid: 'h',
          publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
        })
      )
    ).toEqual([])
  })
})
