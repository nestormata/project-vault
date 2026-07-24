import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_TEMPLATES,
  CREDENTIAL_TEMPLATE_FIELDS,
  DEFAULT_FIELD_KEY,
  FIELD_KEY_PATTERN,
  MAX_FIELDS_PER_SECRET,
  normalizeFieldKey,
  templateFields,
} from './credential-templates.js'
import {
  CredentialTemplateSchema,
  FieldArraySchema,
  FieldMetaSchema,
  FieldSchema,
} from './schemas/credentials.js'

describe('credential template registry (AC-1, AC-2)', () => {
  it('defines exactly the five known templates', () => {
    expect(CREDENTIAL_TEMPLATES).toEqual([
      'login',
      'db_connection',
      'api_key',
      'secure_note',
      'custom',
    ])
  })

  it('login pre-populates username (not sensitive) then password (sensitive), in order', () => {
    expect(CREDENTIAL_TEMPLATE_FIELDS.login).toEqual([
      { key: 'username', sensitive: false },
      { key: 'password', sensitive: true },
    ])
  })

  it('db_connection pre-populates host/port/database/username/password in order', () => {
    expect(CREDENTIAL_TEMPLATE_FIELDS.db_connection.map((f) => f.key)).toEqual([
      'host',
      'port',
      'database',
      'username',
      'password',
    ])
    expect(CREDENTIAL_TEMPLATE_FIELDS.db_connection.at(-1)).toEqual({
      key: 'password',
      sensitive: true,
    })
  })

  it('api_key is a single sensitive `key` field', () => {
    expect(CREDENTIAL_TEMPLATE_FIELDS.api_key).toEqual([{ key: 'key', sensitive: true }])
  })

  it('secure_note is a single sensitive `note` field', () => {
    expect(CREDENTIAL_TEMPLATE_FIELDS.secure_note).toEqual([{ key: 'note', sensitive: true }])
  })

  it('custom starts with zero fields', () => {
    expect(CREDENTIAL_TEMPLATE_FIELDS.custom).toEqual([])
  })

  it('templateFields returns a fresh, mutable copy (not a shared reference)', () => {
    const a = templateFields('login')
    const first = a[0]
    if (first) first.key = 'mutated'
    expect(CREDENTIAL_TEMPLATE_FIELDS.login[0]?.key).toBe('username')
  })
})

describe('normalizeFieldKey (AC-3)', () => {
  it('trims, NFC-normalizes and lowercases', () => {
    expect(normalizeFieldKey('  Password  ')).toBe('password')
  })

  it('treats leading/trailing whitespace variants as identical', () => {
    expect(normalizeFieldKey('password ')).toBe(normalizeFieldKey('password'))
  })

  it('collapses NFC/NFD Unicode-equivalent keys to the same normalized value', () => {
    const composed = 'café' // é as a single NFC code point
    const decomposed = composed.normalize('NFD') // e + combining acute, derived at runtime
    expect(composed).not.toBe(decomposed)
    expect(normalizeFieldKey(composed)).toBe(normalizeFieldKey(decomposed))
  })
})

describe('field schemas (Task 1.2)', () => {
  it('FieldSchema trims the key but not the value', () => {
    expect(FieldSchema.parse({ key: '  host ', value: '  v ', sensitive: false })).toEqual({
      key: 'host',
      value: '  v ',
      sensitive: false,
    })
  })

  it('accepts __proto__ as an ordinary field key (charset allows it)', () => {
    expect(FIELD_KEY_PATTERN.test('__proto__')).toBe(true)
    expect(FieldSchema.parse({ key: '__proto__', value: 'x', sensitive: false }).key).toBe(
      '__proto__'
    )
  })

  it('rejects a key with disallowed characters', () => {
    expect(() => FieldSchema.parse({ key: 'bad/key', value: 'x', sensitive: false })).toThrow()
  })

  it('rejects a key longer than 64 chars', () => {
    expect(() => FieldSchema.parse({ key: 'a'.repeat(65), value: 'x', sensitive: false })).toThrow()
  })

  it('FieldMetaSchema rejects an unknown key like value (no plaintext in meta)', () => {
    expect(() =>
      FieldMetaSchema.parse({ key: 'password', sensitive: true, value: 'secret' })
    ).toThrow()
  })

  it('FieldArraySchema rejects an empty array', () => {
    expect(() => FieldArraySchema.parse([])).toThrow()
  })

  it(`FieldArraySchema rejects more than ${MAX_FIELDS_PER_SECRET} fields`, () => {
    const many = Array.from({ length: MAX_FIELDS_PER_SECRET + 1 }, (_, i) => ({
      key: `f${i}`,
      value: 'v',
      sensitive: false,
    }))
    expect(() => FieldArraySchema.parse(many)).toThrow()
  })

  it('CredentialTemplateSchema rejects an unknown template', () => {
    expect(() => CredentialTemplateSchema.parse('sftp_login')).toThrow()
    expect(CredentialTemplateSchema.parse('db_connection')).toBe('db_connection')
  })

  it('exposes a stable canonical default field key', () => {
    expect(DEFAULT_FIELD_KEY).toBe('value')
  })
})
