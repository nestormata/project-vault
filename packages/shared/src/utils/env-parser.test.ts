import { describe, expect, it } from 'vitest'
import { parseEnvFile } from './env-parser.js'

describe('parseEnvFile', () => {
  it('parses basic KEY=value', () => {
    expect(parseEnvFile('KEY=value')).toEqual({
      entries: [{ name: 'KEY', value: 'value' }],
      warnings: [],
    })
  })

  it('strips double and single quotes', () => {
    expect(parseEnvFile('A="quoted value"\nB=\'single quoted\'')).toEqual({
      entries: [
        { name: 'A', value: 'quoted value' },
        { name: 'B', value: 'single quoted' },
      ],
      warnings: [],
    })
  })

  it('strips export prefix', () => {
    expect(parseEnvFile('export KEY=value')).toEqual({
      entries: [{ name: 'KEY', value: 'value' }],
      warnings: [],
    })
  })

  it('skips comments and blank lines', () => {
    expect(parseEnvFile('# comment\n\nKEY=value')).toEqual({
      entries: [{ name: 'KEY', value: 'value' }],
      warnings: [],
    })
  })

  it('warns on missing equals and excludes entry', () => {
    const result = parseEnvFile('MISSING_EQUALS')
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([{ line: 1, reason: 'no_equals_sign', raw: 'MISSING_EQUALS' }])
  })

  it('warns on empty value but includes entry', () => {
    const result = parseEnvFile('KEY=')
    expect(result.entries).toEqual([{ name: 'KEY', value: '' }])
    expect(result.warnings).toEqual([{ line: 1, reason: 'empty_value', raw: 'KEY=' }])
  })

  it('strips inline comments from unquoted values', () => {
    expect(parseEnvFile('KEY=value # inline comment')).toEqual({
      entries: [{ name: 'KEY', value: 'value' }],
      warnings: [],
    })
  })

  it('keeps equals inside quoted values', () => {
    expect(parseEnvFile('KEY="value with = inside"')).toEqual({
      entries: [{ name: 'KEY', value: 'value with = inside' }],
      warnings: [],
    })
  })

  it('parses unquoted values with multiple equals signs', () => {
    expect(parseEnvFile('KEY=a=b=c')).toEqual({
      entries: [{ name: 'KEY', value: 'a=b=c' }],
      warnings: [],
    })
  })

  it('warns on invalid keys', () => {
    const result = parseEnvFile('1INVALID=value')
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([{ line: 1, reason: 'invalid_key', raw: '1INVALID=value' }])
  })

  it('handles Windows CRLF line endings', () => {
    expect(parseEnvFile('KEY=value\r\nOTHER=ok')).toEqual({
      entries: [
        { name: 'KEY', value: 'value' },
        { name: 'OTHER', value: 'ok' },
      ],
      warnings: [],
    })
  })

  it('trims after export prefix with extra spaces', () => {
    expect(parseEnvFile('export  KEY=value')).toEqual({
      entries: [{ name: 'KEY', value: 'value' }],
      warnings: [],
    })
  })

  it('does not strip hash inside quoted values', () => {
    expect(parseEnvFile('KEY="contains # hash"')).toEqual({
      entries: [{ name: 'KEY', value: 'contains # hash' }],
      warnings: [],
    })
  })

  it('strips unquoted inline comment at space-hash', () => {
    expect(parseEnvFile('KEY=value contains # hash')).toEqual({
      entries: [{ name: 'KEY', value: 'value contains' }],
      warnings: [],
    })
  })

  it('deduplicates keys with last occurrence winning', () => {
    const result = parseEnvFile('KEY=old\nKEY=new')
    expect(result.entries).toEqual([{ name: 'KEY', value: 'new' }])
    expect(result.warnings).toEqual([{ line: 2, reason: 'duplicate_key', raw: 'KEY=new' }])
  })

  it('returns all entries for 501-line file (limit enforced at API)', () => {
    const lines = Array.from({ length: 501 }, (_, i) => `KEY_${i}=v${i}`).join('\n')
    expect(parseEnvFile(lines).entries).toHaveLength(501)
  })
})
