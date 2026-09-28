import { describe, expect, it } from 'vitest'
import { normalizeDwId, parseDwHeadings } from './deferred-work-ledger.js'

const ids = (content: string) => parseDwHeadings(content).map((h) => h.id)

describe('parseDwHeadings (Story 43.11 AC-4 parsing contract)', () => {
  it('returns id, normalizedId, 1-based line and heading level for each DW heading', () => {
    const content =
      '# Deferred Work\n\n## Deferred from: x\n\n### DW-276: Title\n\n#### DW-9: Deep\n'
    expect(parseDwHeadings(content)).toEqual([
      { id: 'DW-276', normalizedId: 'dw-276', line: 5, level: 3 },
      { id: 'DW-9', normalizedId: 'dw-9', line: 7, level: 4 },
    ])
  })

  it('reads the full ID token for variant IDs, stopping at ":" / whitespace / end of line', () => {
    expect(
      ids(
        '### DW-23.2-1: a\n### DW-24-5-1: b\n### DW-12a: c\n### DW-5 Title without colon\n### DW-342\n'
      )
    ).toEqual(['DW-23.2-1', 'DW-24-5-1', 'DW-12a', 'DW-5', 'DW-342'])
  })

  it('ends the ID before a doubled or trailing separator', () => {
    expect(ids('### DW-5.: a\n### DW-24--x: b\n### DW-7-: c\n')).toEqual(['DW-5', 'DW-24', 'DW-7'])
  })

  it('treats DW-24 / DW-24-1 / DW-24-5-1 and DW-51 / DW-151 as distinct IDs', () => {
    const headings = parseDwHeadings(
      '### DW-24:\n### DW-24-1:\n### DW-24-5-1:\n### DW-51:\n### DW-151:\n'
    )
    expect(new Set(headings.map((h) => h.normalizedId)).size).toBe(5)
  })

  it('normalizes case and leading zeros of purely numeric segments', () => {
    expect(normalizeDwId('DW-0276')).toBe('dw-276')
    expect(normalizeDwId('DW-24-05')).toBe('dw-24-5')
    expect(normalizeDwId('DW-12A')).toBe('dw-12a')
    expect(normalizeDwId('DW-0')).toBe('dw-0')
    expect(normalizeDwId('DW-23.02-1')).toBe('dw-23.2-1')
  })

  it('ignores headings inside ``` and ~~~ fences (closed by the same char with >= length)', () => {
    const content =
      '### DW-1: real\n```markdown\n### DW-1: quoted\n~~~\n### DW-1: still quoted\n```\n' +
      '~~~~\n### DW-2: quoted\n~~~\n### DW-2: still quoted (short fence)\n~~~~\n### DW-3: real\n'
    expect(ids(content)).toEqual(['DW-1', 'DW-3'])
  })

  it('an unclosed fence makes the rest of the file "in fence" without crashing', () => {
    expect(ids('### DW-1: a\n```\n### DW-1: b\n### DW-2: c\n')).toEqual(['DW-1'])
  })

  it('ignores prose mentions, "###DW-5:" without a space, lowercase "dw-", and dash look-alikes', () => {
    const content =
      'collided with DW-276 here\n- DW-276\n###DW-5: no space\n### dw-5: lowercase\n' +
      '### DW–276: en dash\n### DW—276: em dash\n'
    expect(ids(content)).toEqual([])
  })

  it('returns [] for an empty file', () => {
    expect(parseDwHeadings('')).toEqual([])
  })

  it('handles CRLF line endings', () => {
    expect(ids('### DW-7: a\r\n### DW-8\r\n')).toEqual(['DW-7', 'DW-8'])
  })
})
