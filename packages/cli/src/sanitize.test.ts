import { describe, expect, it } from 'vitest'
import { sanitizeServerText } from './sanitize-server-text.js'
import { sanitizeForTerminal } from './sanitize.js'

const CAFE_SECRET = 'caf\u00E9-secret'

describe('sanitizeForTerminal', () => {
  it('leaves an ordinary credential name untouched', () => {
    expect(sanitizeForTerminal('DATABASE_URL')).toBe('DATABASE_URL')
  })

  it('strips ANSI escape sequences (ESC-prefixed CSI codes)', () => {
    const malicious = '\u001b[2J\u001b[HFOO'
    expect(sanitizeForTerminal(malicious)).toBe('[2J[HFOO')
  })

  it('strips raw control characters (e.g. cursor-repositioning escapes)', () => {
    const malicious = 'FOO\u0007BAR'
    expect(sanitizeForTerminal(malicious)).toBe('FOOBAR')
  })

  it('strips newlines and tabs so a name cannot fake multi-line output', () => {
    expect(sanitizeForTerminal('FOO\nBAR\tBAZ')).toBe('FOOBARBAZ')
  })

  it('strips C1 control characters', () => {
    expect(sanitizeForTerminal('FOO\u0085BAR')).toBe('FOOBAR')
  })

  it('preserves ordinary unicode text', () => {
    expect(sanitizeForTerminal(CAFE_SECRET)).toBe(CAFE_SECRET)
  })
})

// Story 43.13 AC-1 — sanitizeForTerminal strips the whole unsafe set U (shared with
// sanitizeServerText via @project-vault/agent), keeping its identifier shaping: no truncation, no
// whitespace changes, and line breaks / tabs removed rather than spaced.
const AC1_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['DATABASE_URL', 'DATABASE_URL'],
  [CAFE_SECRET, CAFE_SECRET],
  ['\u30C7\u30FC\u30BF_KEY', '\u30C7\u30FC\u30BF_KEY'],
  ['\x1b[2J\x1b[HFOO', '[2J[HFOO'],
  ['FOO\nBAR\tBAZ', 'FOOBARBAZ'],
  ['FOO\u0085BAR', 'FOOBAR'],
  ['invoice\u202Etxt.exe', 'invoicetxt.exe'],
  ['A\u200BPI_KEY', 'API_KEY'],
  ['KEY\u2066X\u2069', 'KEYX'],
  ['soft\u00ADhyphen', 'softhyphen'],
  ['tag\u{E0041}\u{E007F}', 'tag'],
  ['\uFEFFBOM', 'BOM'],
  ['\u{1F468}\u200D\u{1F469}', '\u{1F468}\u{1F469}'],
  ['', ''],
]

describe('sanitizeForTerminal strips the unsafe set U (Story 43.13 AC-1)', () => {
  it.each(AC1_TABLE)('%j renders as %j', (input, expected) => {
    expect(sanitizeForTerminal(input)).toBe(expected)
  })

  it.each(AC1_TABLE)('sanitizeForTerminal is idempotent for %j', (input) => {
    const once = sanitizeForTerminal(input)
    expect(sanitizeForTerminal(once)).toBe(once)
  })

  it.each(AC1_TABLE)('sanitizeServerText is idempotent for %j', (input) => {
    const once = sanitizeServerText(input)
    expect(sanitizeServerText(once)).toBe(once)
  })

  it('returns a lone surrogate as-is without throwing (both sanitizers)', () => {
    expect(sanitizeForTerminal('\uD800')).toBe('\uD800')
    expect(sanitizeServerText('\uD800')).toBe('\uD800')
  })

  it('never truncates identifier text', () => {
    const long = 'k'.repeat(10_000)
    expect(sanitizeForTerminal(long)).toBe(long)
  })
})
