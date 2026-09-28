import { describe, expect, it } from 'vitest'
import {
  TERMINAL_UNSAFE_CHARACTERS,
  isTerminalUnsafeCharacter,
  stripTerminalUnsafeCharacters,
} from './terminal-unsafe-characters.js'
import * as agentIndex from './index.js'

// Story 43.13 AC-1 — the single definition of the unsafe character set U.
const CASES: ReadonlyArray<readonly [string, string]> = [
  ['DATABASE_URL', 'DATABASE_URL'],
  ['café-secret', 'café-secret'],
  ['データ_KEY', 'データ_KEY'],
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

describe('stripTerminalUnsafeCharacters (Story 43.13 AC-1)', () => {
  it.each(CASES)('strips U from %j', (input, expected) => {
    expect(stripTerminalUnsafeCharacters(input)).toBe(expected)
  })

  it.each(CASES)('is idempotent for %j', (input) => {
    const once = stripTerminalUnsafeCharacters(input)
    expect(stripTerminalUnsafeCharacters(once)).toBe(once)
  })

  it('returns a lone surrogate as-is without throwing', () => {
    expect(stripTerminalUnsafeCharacters('\uD800')).toBe('\uD800')
  })

  it('does not truncate long input', () => {
    const long = 'x'.repeat(10_000)
    expect(stripTerminalUnsafeCharacters(long)).toBe(long)
  })

  it.each([
    ['U+061C', '\u061C'],
    ['U+200E', '\u200E'],
    ['U+200F', '\u200F'],
    ['U+2028 (line separator)', '\u2028'],
    ['U+2029 (paragraph separator)', '\u2029'],
    ['U+2060', '\u2060'],
    ['U+2061', '\u2061'],
    ['U+206F', '\u206F'],
    ['U+E0000 (unassigned, outside \\p{Cf})', '\u{E0000}'],
    ['U+007F', '\u007F'],
    ['U+009F', '\u009F'],
  ])('strips %s', (_label, ch) => {
    expect(stripTerminalUnsafeCharacters(`a${ch}b`)).toBe('ab')
  })

  it.each([
    ['space', ' '],
    ['NBSP', ' '],
    ['U+E0080 (just past the tag block)', '\u{E0080}'],
    ['U+10FFFF', '\u{10FFFF}'],
  ])('keeps %s', (_label, ch) => {
    expect(stripTerminalUnsafeCharacters(`a${ch}b`)).toBe(`a${ch}b`)
  })

  it('exports a unicode-aware, non-global (stateless) regex', () => {
    expect(TERMINAL_UNSAFE_CHARACTERS.flags).toBe('u')
    // A stateful lastIndex would make back-to-back calls disagree.
    expect(stripTerminalUnsafeCharacters('a\u202Eb')).toBe('ab')
    expect(stripTerminalUnsafeCharacters('a\u202Eb')).toBe('ab')
  })

  it('isTerminalUnsafeCharacter classifies single characters, incl. the tag-block edges', () => {
    expect(isTerminalUnsafeCharacter('\u202E')).toBe(true)
    expect(isTerminalUnsafeCharacter('\u{E0000}')).toBe(true)
    expect(isTerminalUnsafeCharacter('\u{E007F}')).toBe(true)
    expect(isTerminalUnsafeCharacter('\u{DFFFF}')).toBe(false)
    expect(isTerminalUnsafeCharacter('\u{E0080}')).toBe(false)
    expect(isTerminalUnsafeCharacter('a')).toBe(false)
    expect(isTerminalUnsafeCharacter('')).toBe(false)
  })

  it('is exported from the package index', () => {
    expect(agentIndex.TERMINAL_UNSAFE_CHARACTERS).toBe(TERMINAL_UNSAFE_CHARACTERS)
    expect(agentIndex.isTerminalUnsafeCharacter).toBe(isTerminalUnsafeCharacter)
    expect(agentIndex.stripTerminalUnsafeCharacters).toBe(stripTerminalUnsafeCharacters)
  })
})
