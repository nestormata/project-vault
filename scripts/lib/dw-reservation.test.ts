import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDwHeadings } from './deferred-work-ledger.js'
import {
  formatReservationStub,
  isValidStoryKey,
  parseReservations,
  replaceReservation,
  RESERVATION_STALE_DAYS,
  RESERVED_SECTION,
} from './dw-reservation.js'
import { useFixtureRoots } from './fixture-test-helpers.js'

const makeFixtureRoot = useFixtureRoots('dw-reservation-', [])
const NOW = new Date('2026-10-11T12:00:00.000Z')

describe('constants', () => {
  it('pins the stale threshold at 7 days and the section heading', () => {
    expect(RESERVATION_STALE_DAYS).toBe(7)
    expect(RESERVED_SECTION).toBe('## Reserved (not yet written)')
  })
})

describe('isValidStoryKey', () => {
  it.each(['66-19', '66-19-epic-66-completion', '43.11', '20-15a', '70-4-x.y'])(
    'accepts %s',
    (key) => expect(isValidStoryKey(key)).toBe(true)
  )
  it.each(['', 'abc', '66-19\n### DW-1', '66 19', '66-19#x', '-66', '66-19 extra'])(
    'rejects %j',
    (key) => expect(isValidStoryKey(key)).toBe(false)
  )
})

describe('formatReservationStub / parseReservations', () => {
  it('writes a stub that the shared heading parser sees as a normal ### DW heading', () => {
    const stub = formatReservationStub(12, '66-19', NOW)
    expect(stub).toBe('### DW-12: RESERVED 66-19 2026-10-11T12:00:00.000Z\nstatus: reserved\n')
    expect(parseDwHeadings(stub)).toMatchObject([{ id: 'DW-12', level: 3, line: 1 }])
  })

  it('round-trips through parseReservations', () => {
    const [reservation] = parseReservations(`# L\n\n${formatReservationStub(12, '66-19', NOW)}`)
    expect(reservation).toMatchObject({
      id: 'DW-12',
      normalizedId: 'dw-12',
      story: '66-19',
      line: 3,
      timestampMs: NOW.getTime(),
    })
  })

  it('ignores a stub inside a fenced code block', () => {
    const fenced = `\`\`\`markdown\n${formatReservationStub(12, '66-19', NOW)}\`\`\`\n`
    expect(parseReservations(fenced)).toEqual([])
  })

  it('does not treat a real entry as a stub', () => {
    expect(parseReservations('### DW-5: Reserved word in a title\nstatus: open\n')).toEqual([])
  })

  it.each([
    ['not a date', '### DW-5: RESERVED 66-19 yesterday\n'],
    ['missing timestamp', '### DW-5: RESERVED 66-19\n'],
    ['non-ISO date-only', '### DW-5: RESERVED 66-19 2026-10-11\n'],
    ['impossible date', '### DW-5: RESERVED 66-19 2026-13-45T00:00:00.000Z\n'],
  ])('keeps a stub with an unparsable timestamp (%s) so the guard can fail closed', (_n, text) => {
    const [reservation] = parseReservations(text)
    expect(reservation?.id).toBe('DW-5')
    expect(reservation?.timestampMs).toBeUndefined()
  })
})

describe('replaceReservation', () => {
  const ledgerWith = (...parts: string[]) =>
    `# Deferred Work\n\n### DW-1: a\nstatus: done\n\n${parts.join('\n')}`

  function write(content: string): string {
    const path = join(makeFixtureRoot(), 'deferred-work.md')
    writeFileSync(path, content)
    return path
  }

  it('replaces the stub block with the real entry, leaving no second heading and no temp file', () => {
    const path = write(
      ledgerWith(
        `${RESERVED_SECTION}\n\n${formatReservationStub(2, '66-19', NOW)}\n${formatReservationStub(3, '66-19', NOW)}`
      )
    )
    replaceReservation(
      path,
      'DW-2',
      '### DW-2: real title\nstatus: open — Trigger to revisit: next change to scripts/x.ts.\n'
    )
    const content = readFileSync(path, 'utf-8')
    expect(parseDwHeadings(content).map((h) => h.id)).toEqual(['DW-1', 'DW-2', 'DW-3'])
    expect(content).toContain('### DW-2: real title')
    expect(parseReservations(content).map((r) => r.id)).toEqual(['DW-3'])
    expect(content).toContain(`### DW-1: a\nstatus: done\n`)
    expect(readdirSync(join(path, '..'))).toEqual(['deferred-work.md'])
  })

  it('throws and leaves the file untouched when there is no stub for the ID', () => {
    const original = ledgerWith(`${RESERVED_SECTION}\n\n${formatReservationStub(2, '66-19', NOW)}`)
    const path = write(original)
    expect(() => replaceReservation(path, 'DW-9', '### DW-9: x\nstatus: done\n')).toThrow(
      /no reservation stub for DW-9/
    )
    expect(readFileSync(path, 'utf-8')).toBe(original)
  })

  it('throws when the entry text does not start with the matching heading', () => {
    const original = ledgerWith(`${RESERVED_SECTION}\n\n${formatReservationStub(2, '66-19', NOW)}`)
    const path = write(original)
    expect(() => replaceReservation(path, 'DW-2', '### DW-3: wrong id\n')).toThrow(
      /must start with/
    )
    expect(() => replaceReservation(path, 'DW-2', 'no heading at all\n')).toThrow(/must start with/)
    expect(readFileSync(path, 'utf-8')).toBe(original)
  })
})
