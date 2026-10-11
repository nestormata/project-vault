/**
 * Story 66-19 (epic-66 retro Finding 2): DW-number reservation stubs.
 *
 * `next-dw-id --reserve` appends `### DW-<n>: RESERVED <story-key> <ISO timestamp>` under
 * `## Reserved (not yet written)` the moment an ID is allocated, so the next allocation (which reads
 * the working-tree ledger) sees it. The stub is an ordinary `### DW-` heading, so the shared parser,
 * the duplicate guard and the allocator all see it; the real entry must REPLACE it
 * (`replaceReservation`), never be added beside it.
 */
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeDwId, parseDwEntries, parseDwHeadings } from './deferred-work-ledger.js'
import { safeEditFile, withFileLock } from './safe-edit.js'

/** A reservation older than this many days that was never filled in fails CI. */
export const RESERVATION_STALE_DAYS = 7
export const RESERVED_SECTION = '## Reserved (not yet written)'
/** Lock file name, created next to the ledger's real file. */
export const LEDGER_LOCK_NAME = 'deferred-work.md.lock'

const STORY_KEY = /^\d[0-9A-Za-z.-]*$/
/** The exact `Date#toISOString()` shape this module writes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STUB_PREFIX = /^#{1,6}[ \t]+DW-[0-9A-Za-z.-]+:?[ \t]+RESERVED(?![0-9A-Za-z])/

/** The story key is written into a heading: digits-led, no whitespace, `#` or newline. */
export function isValidStoryKey(key: string): boolean {
  return STORY_KEY.test(key)
}

export function formatReservationStub(n: number, story: string, now: Date): string {
  return `### DW-${n}: RESERVED ${story} ${now.toISOString()}\nstatus: reserved\n`
}

export type Reservation = {
  id: string
  normalizedId: string
  line: number
  story: string
  /** The timestamp token as written (may be missing or junk). */
  timestampText: string
  /** Epoch ms; undefined when the timestamp does not parse (the guard fails closed on that). */
  timestampMs: number | undefined
}

function parseTimestamp(text: string): number | undefined {
  if (!ISO_TIMESTAMP.test(text)) return undefined
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? undefined : ms
}

/** Every non-fenced RESERVED stub heading in `content`. */
export function parseReservations(content: string): Reservation[] {
  const lines = content.split('\n')
  return parseDwHeadings(content).flatMap((heading) => {
    const text = (lines[heading.line - 1] ?? '').replace(/\r$/, '')
    const prefix = STUB_PREFIX.exec(text)
    if (!prefix) return []
    const [story = '', timestampText = ''] = text.slice(prefix[0].length).trim().split(/\s+/)
    return [
      {
        id: heading.id,
        normalizedId: heading.normalizedId,
        line: heading.line,
        story,
        timestampText,
        timestampMs: parseTimestamp(timestampText),
      },
    ]
  })
}

/** The lock path for a ledger (next to its real file, never in the OS temp dir). */
export function ledgerLockPath(ledgerPath: string): string {
  return join(dirname(realpathSync(ledgerPath)), LEDGER_LOCK_NAME)
}

/** `lines` index range [start, endExclusive) of the stub block for `normalizedId`, trailing blanks excluded. */
function stubBlock(content: string, normalizedId: string): [number, number] | undefined {
  const stub = parseReservations(content).find((r) => r.normalizedId === normalizedId)
  if (!stub) return undefined
  const entry = parseDwEntries(content).find((e) => e.line === stub.line)
  const lines = content.split('\n')
  let end = Math.min(entry?.bodyEndLine ?? stub.line, lines.length)
  while (end > stub.line && (lines[end - 1] ?? '').trim() === '') end -= 1
  return [stub.line - 1, end]
}

/**
 * Replaces the RESERVED stub for `id` with the real entry (one heading, no second DW heading).
 * `entryText` must start with `### DW-<same id>`. Runs under the ledger lock and through
 * `safeEditFile`, so a failure leaves the ledger byte-identical.
 */
export function replaceReservation(ledgerPath: string, id: string, entryText: string): void {
  const wanted = normalizeDwId(id)
  const first = parseDwHeadings(entryText)[0]
  if (first?.line !== 1 || first.normalizedId !== wanted || first.level !== 3) {
    throw new Error(`replaceReservation: the entry text must start with a \`### ${id}\` heading`)
  }
  withFileLock(ledgerLockPath(ledgerPath), () => {
    safeEditFile(ledgerPath, (content) => {
      const block = stubBlock(content, wanted)
      if (!block) throw new Error(`replaceReservation: no reservation stub for ${id}`)
      const lines = content.split('\n')
      lines.splice(block[0], block[1] - block[0], ...entryText.trimEnd().split('\n'))
      return lines.join('\n')
    })
  })
}
