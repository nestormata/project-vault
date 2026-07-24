import { describe, expect, it } from 'vitest'
import {
  FieldKeyConflictError,
  assertUniqueFieldKeys,
  buildFieldMeta,
  computeFieldDelta,
  fieldMetaForResponse,
  parseFieldsFromPlaintext,
  resolveFieldSet,
  serializeFieldEnvelope,
  unwrapRevealValue,
} from './field-set.js'

const f = (key: string, value = 'v', sensitive = false) => ({ key, value, sensitive })

describe('assertUniqueFieldKeys (AC-3)', () => {
  it('accepts distinct keys', () => {
    expect(() => assertUniqueFieldKeys([f('username'), f('password')])).not.toThrow()
  })

  it('rejects a case-insensitive collision', () => {
    expect(() => assertUniqueFieldKeys([f('username'), f('Username')])).toThrow(
      FieldKeyConflictError
    )
  })

  it('rejects a whitespace-only-difference collision (keys are trimmed upstream, compared trimmed)', () => {
    expect(() => assertUniqueFieldKeys([f('password'), f('password ')])).toThrow(
      FieldKeyConflictError
    )
  })

  it('rejects an NFC/NFD Unicode-equivalent collision', () => {
    expect(() => assertUniqueFieldKeys([f('café'), f('café')])).toThrow(FieldKeyConflictError)
  })

  it('treats __proto__ as an ordinary key with no prototype pollution', () => {
    // Two distinct keys, one literally "__proto__": must not collide, must not pollute Object proto.
    expect(() => assertUniqueFieldKeys([f('__proto__'), f('constructor')])).not.toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // A real __proto__ collision is still detected.
    expect(() => assertUniqueFieldKeys([f('__proto__'), f('__proto__')])).toThrow(
      FieldKeyConflictError
    )
  })

  it('carries the conflicting key on the error', () => {
    try {
      assertUniqueFieldKeys([f('ApiKey'), f('apikey')])
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(FieldKeyConflictError)
      expect((err as FieldKeyConflictError).conflictingKey).toBe('apikey')
    }
  })
})

describe('resolveFieldSet (AC-5)', () => {
  it('synthesizes a single default field for a legacy { value } body', () => {
    expect(resolveFieldSet({ value: 'secret' })).toEqual({
      fields: [{ key: 'value', value: 'secret', sensitive: true }],
    })
  })

  it('passes through a field-set body and preserves template', () => {
    const resolved = resolveFieldSet({
      template: 'login',
      fields: [f('username'), f('password', 'p', true)],
    })
    expect(resolved.template).toBe('login')
    expect(resolved.fields.map((x) => x.key)).toEqual(['username', 'password'])
  })

  it('throws on a duplicate key in a field-set body before any write', () => {
    expect(() => resolveFieldSet({ fields: [f('a'), f('A')] })).toThrow(FieldKeyConflictError)
  })
})

describe('buildFieldMeta / serializeFieldEnvelope (AC-4)', () => {
  it('field_meta contains only key/sensitive/template — never a value', () => {
    const meta = buildFieldMeta({
      template: 'login',
      fields: [f('username', 'alice'), f('password', 's3cret', true)],
    })
    expect(meta).toEqual([
      { key: 'username', sensitive: false, template: 'login' },
      { key: 'password', sensitive: true, template: 'login' },
    ])
    expect(JSON.stringify(meta)).not.toContain('alice')
    expect(JSON.stringify(meta)).not.toContain('s3cret')
  })

  it('omits template when absent', () => {
    expect(buildFieldMeta({ fields: [f('value', 'x', true)] })).toEqual([
      { key: 'value', sensitive: true },
    ])
  })

  it('round-trips values through the encrypted envelope shape', () => {
    const resolved = resolveFieldSet({
      fields: [f('host', 'db.example'), f('password', 'pw', true)],
    })
    const envelope = serializeFieldEnvelope(resolved)
    expect(parseFieldsFromPlaintext(2, envelope)).toEqual([
      { key: 'host', value: 'db.example', sensitive: false },
      { key: 'password', value: 'pw', sensitive: true },
    ])
  })
})

describe('legacy read paths (AC-7)', () => {
  it('fieldMetaForResponse wraps a legacy (schema_version 1) row into one default field', () => {
    expect(fieldMetaForResponse(1, null)).toEqual([{ key: 'value', sensitive: true }])
  })

  it('fieldMetaForResponse returns stored meta for a v2 row', () => {
    const meta = [{ key: 'note', sensitive: true, template: 'secure_note' }]
    expect(fieldMetaForResponse(2, meta)).toEqual(meta)
  })

  it('unwrapRevealValue returns the bare string for a legacy row', () => {
    expect(unwrapRevealValue(1, 'plain-secret')).toBe('plain-secret')
  })

  it('unwrapRevealValue unwraps a single-default-field v2 row to its bare value', () => {
    const env = serializeFieldEnvelope(resolveFieldSet({ value: 'sk_live_x' }))
    expect(unwrapRevealValue(2, env)).toBe('sk_live_x')
  })

  it('unwrapRevealValue returns the full JSON envelope for a genuine multi-field v2 row', () => {
    const env = serializeFieldEnvelope(resolveFieldSet({ fields: [f('u'), f('p', 'x', true)] }))
    expect(unwrapRevealValue(2, env)).toBe(env)
  })

  it('parseFieldsFromPlaintext wraps a legacy bare string into a single default field', () => {
    expect(parseFieldsFromPlaintext(1, 'bare')).toEqual([
      { key: 'value', value: 'bare', sensitive: true },
    ])
  })
})

describe('computeFieldDelta (AC-9)', () => {
  it('reports added and removed keys (a rename surfaces as one added + one removed)', () => {
    expect(computeFieldDelta(['username', 'password'], ['login', 'password'])).toEqual({
      addedFields: ['login'],
      removedFields: ['username'],
    })
  })

  it('reports an added field with no removals', () => {
    expect(computeFieldDelta(['username', 'password'], ['username', 'password', 'notes'])).toEqual({
      addedFields: ['notes'],
      removedFields: [],
    })
  })

  it('is case-insensitive (no spurious churn for a case-only change of an unchanged key)', () => {
    expect(computeFieldDelta(['Host'], ['host'])).toEqual({ addedFields: [], removedFields: [] })
  })
})
