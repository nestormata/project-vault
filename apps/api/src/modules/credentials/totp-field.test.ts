import { describe, expect, it } from 'vitest'
import {
  assertValidTotpSeeds,
  generateTotpCode,
  InvalidTotpSeedError,
  parseTotpSeed,
} from './totp-field.js'
import {
  plaintextWithoutTotpSeeds,
  resolveFieldSet,
  serializeFieldEnvelope,
  withoutTotpFields,
} from './field-set.js'
import { TotpSeedRequiredError } from './totp-field.js'

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890".
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SECRET_SENTINEL = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'

describe('parseTotpSeed (72-10)', () => {
  it('accepts a Base32 secret regardless of case, spaces, dashes and padding', () => {
    expect(parseTotpSeed(RFC_SEED)).not.toBeNull()
    expect(parseTotpSeed(RFC_SEED.toLowerCase())).not.toBeNull()
    expect(parseTotpSeed('GEZD GNBV-GY3T QOJQ GEZD GNBV GY3T QOJQ====')).not.toBeNull()
  })

  it('accepts an otpauth link and honours its digits and period', () => {
    const parsed = parseTotpSeed(
      `otpauth://totp/Example:alice?secret=${RFC_SEED}&digits=8&period=60&algorithm=SHA256`
    )
    expect(parsed?.digits).toBe(8)
    expect(parsed?.period).toBe(60)
    expect(parsed?.algorithm).toBe('SHA256')
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', 'GEZDGNBV'],
    ['not Base32', 'not a base32 secret at all!!'],
    ['digit 1 is not Base32', '1111111111111111'],
    ['an hotp link', `otpauth://hotp/x?secret=${RFC_SEED}&counter=1`],
    ['digits out of range', `otpauth://totp/x?secret=${RFC_SEED}&digits=12`],
    ['period out of range', `otpauth://totp/x?secret=${RFC_SEED}&period=1`],
    ['an unreadable link', 'otpauth://totp/x?nosecret=1'],
  ])('rejects %s', (_label, input) => {
    expect(parseTotpSeed(input)).toBeNull()
  })
})

describe('generateTotpCode (72-10)', () => {
  it('matches the RFC 6238 SHA-1 vector at T=59 s (6 digits)', () => {
    expect(generateTotpCode(RFC_SEED, 59_000)?.code).toBe('287082')
    expect(generateTotpCode(RFC_SEED, 1_111_111_109_000)?.code).toBe('081804')
    expect(generateTotpCode(RFC_SEED, 1_234_567_890_000)?.code).toBe('005924')
  })

  it('honours 8 digits from an otpauth link (RFC vector 94287082)', () => {
    const link = `otpauth://totp/x?secret=${RFC_SEED}&digits=8`
    expect(generateTotpCode(link, 59_000)?.code).toBe('94287082')
  })

  it('reports when the code stops being current', () => {
    const generated = generateTotpCode(RFC_SEED, 59_000)
    expect(generated).toMatchObject({
      digits: 6,
      periodSeconds: 30,
      expiresAt: new Date(60_000).toISOString(),
      secondsRemaining: 1,
    })
    expect(generateTotpCode(RFC_SEED, 60_000)?.secondsRemaining).toBe(30)
  })

  it('returns null for a seed that cannot produce codes', () => {
    expect(generateTotpCode('', 0)).toBeNull()
    expect(generateTotpCode('nope', 0)).toBeNull()
  })
})

describe('field sets with a totp field (72-10)', () => {
  const body = (value: string) => ({
    fields: [
      { key: 'username', value: 'alice', sensitive: false },
      { key: '2FA', value, sensitive: false, kind: 'totp' as const },
    ],
  })

  it('forces a totp field to be sensitive and keeps its kind', () => {
    const resolved = resolveFieldSet(body(RFC_SEED))
    expect(resolved.fields[1]).toEqual({
      key: '2FA',
      value: RFC_SEED,
      sensitive: true,
      kind: 'totp',
    })
    // A field of the default kind stores nothing new.
    expect(resolved.fields[0]).toEqual({ key: 'username', value: 'alice', sensitive: false })
    expect(Object.keys(resolved.fields[0] ?? {})).not.toContain('kind')
  })

  it('does not write a kind for text, so existing credentials are stored unchanged', () => {
    const resolved = resolveFieldSet({
      fields: [{ key: 'note', value: 'x', sensitive: true, kind: 'text' }],
    })
    expect(serializeFieldEnvelope(resolved)).toBe('[{"key":"note","value":"x","sensitive":true}]')
  })

  it('rejects an invalid seed by field key without echoing the seed', () => {
    const attempt = () => resolveFieldSet(body('not a seed 1890!'))
    expect(attempt).toThrow(InvalidTotpSeedError)
    try {
      attempt()
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('not a seed 1890!')
      expect((error as InvalidTotpSeedError).fieldKey).toBe('2FA')
    }
  })

  it('keeps the stored seed when an edit sends an empty one, matching the key case-insensitively', () => {
    const previous = [
      { key: '2fa', value: RFC_SEED, sensitive: true, kind: 'totp' as const },
      { key: 'username', value: 'alice', sensitive: false },
    ]
    const resolved = resolveFieldSet(body(''), previous)
    expect(resolved.fields[1]?.value).toBe(RFC_SEED)
  })

  it('fails when there is no stored seed to keep', () => {
    expect(() => resolveFieldSet(body(''))).toThrow(TotpSeedRequiredError)
    expect(() =>
      resolveFieldSet(body(''), [{ key: '2FA', value: 'plain text field', sensitive: true }])
    ).toThrow(TotpSeedRequiredError)
    expect(() =>
      assertValidTotpSeeds([{ key: 'x', value: '', sensitive: true, kind: 'totp' }])
    ).toThrow(InvalidTotpSeedError)
  })

  it('drops totp fields from a read and blanks the seed for an export', () => {
    const resolved = resolveFieldSet(body(SECRET_SENTINEL))
    expect(withoutTotpFields(resolved.fields).map((entry) => entry.key)).toEqual(['username'])

    const plaintext = serializeFieldEnvelope(resolved)
    const exported = plaintextWithoutTotpSeeds(2, plaintext)
    expect(exported).not.toContain(SECRET_SENTINEL)
    expect(JSON.parse(exported)).toEqual([
      { key: 'username', value: 'alice', sensitive: false },
      { key: '2FA', value: '', sensitive: true, kind: 'totp' },
    ])
    // Rows with no totp field, and legacy rows, are returned byte for byte.
    const plain = '[{"key":"a","value":"b","sensitive":true}]'
    expect(plaintextWithoutTotpSeeds(2, plain)).toBe(plain)
    expect(plaintextWithoutTotpSeeds(1, 'legacy bare value')).toBe('legacy bare value')
  })
})
