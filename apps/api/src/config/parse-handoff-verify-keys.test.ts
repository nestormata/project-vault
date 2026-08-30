import { describe, expect, it } from 'vitest'
import { HandoffVerifyKeysParseError, parseHandoffVerifyKeys } from './env.js'

// Story 30.1 (DW-129) Task 2: parseHandoffVerifyKeys in isolation — pure function, no DB/network.
// The env.ts superRefine validation (env.test.ts) exercises the same function via boot; these
// tests exercise the shared implementation directly.
const VALID_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  // base64 test-fixture bytes, not a credential — an arbitrary well-formed-PEM shape fixture.
  // eslint-disable-next-line no-secrets/no-secrets
  'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=',
  '-----END PUBLIC KEY-----',
].join('\n')

describe('parseHandoffVerifyKeys', () => {
  it('unset pass-through: returns an empty array for undefined', () => {
    expect(parseHandoffVerifyKeys(undefined)).toEqual([])
  })

  it('empty-array pass-through: returns an empty array for "[]"', () => {
    expect(parseHandoffVerifyKeys('[]')).toEqual([])
  })

  it('parses a valid single-key array', () => {
    const raw = JSON.stringify([{ kid: 'key-1', publicKeyPem: VALID_PEM }])
    expect(parseHandoffVerifyKeys(raw)).toEqual([{ kid: 'key-1', publicKeyPem: VALID_PEM }])
  })

  it('parses a valid multi-key array, preserving order', () => {
    const raw = JSON.stringify([
      { kid: 'key-1', publicKeyPem: VALID_PEM },
      { kid: 'key-2', publicKeyPem: VALID_PEM },
    ])
    expect(parseHandoffVerifyKeys(raw)).toEqual([
      { kid: 'key-1', publicKeyPem: VALID_PEM },
      { kid: 'key-2', publicKeyPem: VALID_PEM },
    ])
  })

  it('throws HandoffVerifyKeysParseError on malformed JSON', () => {
    expect(() => parseHandoffVerifyKeys('{not valid json')).toThrow(HandoffVerifyKeysParseError)
  })

  it('throws HandoffVerifyKeysParseError when the parsed value is not an array', () => {
    const raw = JSON.stringify({ kid: 'key-1', publicKeyPem: VALID_PEM })
    expect(() => parseHandoffVerifyKeys(raw)).toThrow(HandoffVerifyKeysParseError)
  })

  it('throws HandoffVerifyKeysParseError on a duplicate kid across two entries', () => {
    const raw = JSON.stringify([
      { kid: 'key-1', publicKeyPem: VALID_PEM },
      { kid: 'key-1', publicKeyPem: VALID_PEM },
    ])
    expect(() => parseHandoffVerifyKeys(raw)).toThrow(/unique/)
  })

  it('throws HandoffVerifyKeysParseError when publicKeyPem is missing its PEM footer', () => {
    const malformedPem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...'
    const raw = JSON.stringify([{ kid: 'key-1', publicKeyPem: malformedPem }])
    expect(() => parseHandoffVerifyKeys(raw)).toThrow(/PEM/)
  })

  it('throws HandoffVerifyKeysParseError on an empty-string kid', () => {
    const raw = JSON.stringify([{ kid: '', publicKeyPem: VALID_PEM }])
    expect(() => parseHandoffVerifyKeys(raw)).toThrow(/kid/)
  })

  it('throws HandoffVerifyKeysParseError on a kid over 128 characters', () => {
    const raw = JSON.stringify([{ kid: 'k'.repeat(129), publicKeyPem: VALID_PEM }])
    expect(() => parseHandoffVerifyKeys(raw)).toThrow(/kid/)
  })
})
