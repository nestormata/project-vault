import { describe, expect, it } from 'vitest'
import { sanitizeForTerminal } from './sanitize.js'

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
    expect(sanitizeForTerminal('café-secret')).toBe('café-secret')
  })
})
