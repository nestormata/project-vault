import { describe, expect, it } from 'vitest'
import { sanitizeServerText } from './sanitize-server-text.js'

describe('sanitizeServerText (Story 43.6 D6)', () => {
  it('removes ESC so ANSI sequences become inert', () => {
    expect(sanitizeServerText('\x1b[2J\x1b[31mFAKE')).toBe('[2J[31mFAKE')
  })

  it('removes OSC-8 hyperlink control characters', () => {
    expect(sanitizeServerText('\x1b]8;;https://evil.example/\x07click\x1b]8;;\x07')).toBe(
      ']8;;https://evil.example/click]8;;'
    )
  })

  it('strips a right-to-left override', () => {
    expect(sanitizeServerText('safe\u202Eexe.txt')).toBe('safeexe.txt')
  })

  it('collapses a newline into a single space', () => {
    expect(sanitizeServerText('line1\nline2')).toBe('line1 line2')
  })

  it.each([
    ['\u202A', 'bidi embedding'],
    ['\u202B', 'bidi embedding'],
    ['\u202C', 'pop directional'],
    ['\u202D', 'bidi override'],
    ['\u2066', 'isolate'],
    ['\u2067', 'isolate'],
    ['\u2068', 'isolate'],
    ['\u2069', 'pop isolate'],
    ['\u200E', 'LRM'],
    ['\u200F', 'RLM'],
    ['\u200B', 'zero-width space'],
    ['\u200C', 'ZWNJ'],
    ['\u200D', 'ZWJ'],
    ['\u2060', 'word joiner'],
    ['\uFEFF', 'BOM'],
    ['\u0085', 'C1 NEL'],
    ['\u009B', 'C1 CSI'],
    ['\x7f', 'DEL'],
  ])('strips %j (%s)', (char) => {
    expect(sanitizeServerText(`a${char}b`)).toBe('ab')
  })

  it.each(['\u2028', '\u2029', '\t', '\r\n'])('turns separator %j into one space', (sep) => {
    expect(sanitizeServerText(`a${sep}b`)).toBe('a b')
  })

  it('collapses whitespace runs and trims', () => {
    expect(sanitizeServerText('  a   \n\n  b  ')).toBe('a b')
  })

  it('truncates to 200 code points with an ellipsis', () => {
    const out = sanitizeServerText('x'.repeat(500))
    expect([...out]).toHaveLength(200)
    expect(out.endsWith('…')).toBe(true)
  })

  it('counts code points, never splitting a surrogate pair', () => {
    const out = sanitizeServerText('😀'.repeat(300))
    expect([...out]).toHaveLength(200)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('leaves text at exactly the limit untouched', () => {
    const text = 'y'.repeat(200)
    expect(sanitizeServerText(text)).toBe(text)
  })

  it('accepts a custom limit', () => {
    expect(sanitizeServerText('abcdef', 4)).toBe('abc…')
  })
})
