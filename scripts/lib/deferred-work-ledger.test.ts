import { describe, expect, it } from 'vitest'
import {
  createFenceTracker,
  extractDwCitations,
  normalizeDwId,
  parseDwEntries,
  parseDwHeadings,
} from './deferred-work-ledger.js'

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

const OPEN = 'status: open'

const bodyTexts = (content: string) =>
  parseDwEntries(content).map((e) => ({ id: e.id, texts: e.lines.map((l) => l.text) }))

describe('parseDwEntries (Story 43.12 AC-5.1 entry bodies)', () => {
  it('returns each heading plus its body range and body lines', () => {
    const content = '### DW-1: a\norigin: x\nstatus: open\n\n### DW-2: b\nstatus: done\n'
    expect(parseDwEntries(content)).toEqual([
      {
        id: 'DW-1',
        normalizedId: 'dw-1',
        line: 1,
        level: 3,
        bodyStartLine: 2,
        bodyEndLine: 4,
        lines: [
          { line: 2, text: 'origin: x' },
          { line: 3, text: OPEN },
          { line: 4, text: '' },
        ],
      },
      {
        id: 'DW-2',
        normalizedId: 'dw-2',
        line: 5,
        level: 3,
        bodyStartLine: 6,
        bodyEndLine: 7,
        lines: [
          { line: 6, text: 'status: done' },
          { line: 7, text: '' },
        ],
      },
    ])
  })

  it('ends a body at any other heading (level 1-6), not only at the next DW heading', () => {
    const content = '### DW-1: a\nstatus: open\n## Deferred from: y\nprose\n#### Note\n'
    expect(bodyTexts(content)).toEqual([{ id: 'DW-1', texts: [OPEN] }])
  })

  it('ends a body at a flat "- source_spec:" / "* source_spec:" bullet at or after the status line', () => {
    expect(
      bodyTexts('### DW-1: a\nstatus: open\nreason: r\n- source_spec: x.md\n- item\n')
    ).toEqual([{ id: 'DW-1', texts: [OPEN, 'reason: r'] }])
    expect(bodyTexts('### DW-1: a\nstatus: open\n* source_spec: x.md\n')).toEqual([
      { id: 'DW-1', texts: [OPEN] },
    ])
  })

  it('never ends a body at a flat source_spec bullet above the first status line', () => {
    expect(bodyTexts('### DW-1: a\n- source_spec: x.md\nstatus: open\n')).toEqual([
      { id: 'DW-1', texts: ['- source_spec: x.md', OPEN, ''] },
    ])
  })

  it('runs the last body to EOF, and gives an empty body for a heading at EOF', () => {
    expect(bodyTexts('### DW-1: a\nstatus: open')).toEqual([{ id: 'DW-1', texts: [OPEN] }])
    const [entry] = parseDwEntries('### DW-9: last')
    expect(entry).toMatchObject({ bodyStartLine: 2, bodyEndLine: 1, lines: [] })
  })

  it('skips fenced lines inside a body, and a fenced heading does not end the body', () => {
    const content =
      '### DW-1: a\nstatus: open\n```\n### DW-2: quoted\nTrigger: fenced\n```\nafter\n### DW-3: b\n'
    expect(bodyTexts(content)).toEqual([
      { id: 'DW-1', texts: [OPEN, 'after'] },
      { id: 'DW-3', texts: [''] },
    ])
  })

  it('keeps two adjacent entries apart and parses variant IDs', () => {
    expect(bodyTexts('### DW-23.2-1: a\nx\n### DW-24-5-1: b\ny\n')).toEqual([
      { id: 'DW-23.2-1', texts: ['x'] },
      { id: 'DW-24-5-1', texts: ['y', ''] },
    ])
  })

  it('handles CRLF line endings', () => {
    expect(bodyTexts('### DW-1: a\r\nstatus: open\r\n')).toEqual([
      { id: 'DW-1', texts: [OPEN, ''] },
    ])
  })

  it('agrees with parseDwHeadings on every heading', () => {
    const content = '# T\n### DW-1: a\n```\n### DW-1: q\n```\n#### DW-2: b\n'
    expect(parseDwEntries(content).map(({ id, line, level }) => ({ id, line, level }))).toEqual(
      parseDwHeadings(content).map(({ id, line, level }) => ({ id, line, level }))
    )
  })
})

describe('createFenceTracker (Story 43.12, shared with the review-section extractor)', () => {
  it('reports fence lines and fenced lines as fenced', () => {
    const fenced = createFenceTracker()
    expect(['a', '```', '# x', '```', 'b', '~~~~', '~~~', 'c'].map(fenced)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
    ])
  })
})

describe('extractDwCitations (Story 43.12 AC-2 rule 3)', () => {
  it('trims trailing punctuation with the heading parser semantics', () => {
    expect(
      extractDwCitations('DW-344. DW-344, (ledgered as DW-344) DW-23.2-1 and DW-0344; DW-5.:')
    ).toEqual(['DW-344', 'DW-344', 'DW-344', 'DW-23.2-1', 'DW-0344', 'DW-5'])
  })

  it('splits ranges and joined pairs into both IDs (DW-355..DW-391, DW-318-DW-319)', () => {
    expect(extractDwCitations('DW-355..DW-391 and DW-318-DW-319; DW-23.2-1.DW-7')).toEqual([
      'DW-355',
      'DW-391',
      'DW-318',
      'DW-319',
      'DW-23.2-1',
      'DW-7',
    ])
  })

  it('ignores lowercase and in-word mentions', () => {
    expect(extractDwCitations('dw-5 XDW-6 DW- ')).toEqual([])
  })
})
