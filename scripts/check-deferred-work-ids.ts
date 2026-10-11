#!/usr/bin/env tsx
/**
 * Story 43.11 (epic-43 retro Finding 2, a REPEAT of the epic-28 DW-ID traceability item) —
 * `deferred-work.md` held two `### DW-276` entries, and the same collision recurred three times on
 * 2026-09-27 alone: concurrent sessions each take "highest DW number + 1" on their own branch,
 * append under different `## Deferred from:` sections, and git merges the result without a textual
 * conflict. This guard fails the push that introduces a duplicate instead of leaving it to the
 * next retro's manual sweep. Allocate new IDs with `pnpm next-dw-id --fetch`.
 *
 * FATAL: a DW ID declared by two or more headings; a DW heading at a level other than `###`
 * (every consumer keys on `### `, so a `####` entry is invisible to them).
 *
 * Pure, DB-free: a static scan of `_bmad-output/implementation-artifacts/deferred-work.md` using
 * the shared parser in `lib/deferred-work-ledger.ts`.
 */
import { pathToFileURL } from 'node:url'
import { type DwHeading, parseDwHeadings } from './lib/deferred-work-ledger.js'
import { parseReservations, RESERVATION_STALE_DAYS } from './lib/dw-reservation.js'
import {
  formatLineRefs,
  type OverlayShape,
  readOverlayFile,
  runOverlayGuard,
} from './lib/scan-utils.js'

export const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'

/** Story 66-19 AC-4: a ledger with bytes but no `### DW-` heading was most likely truncated. */
export const DEFERRED_WORK_SHAPE: OverlayShape = {
  pattern: /^#{1,6}[ \t]+DW-/m,
  expected: 'DW entry (`### DW-`) heading',
}

export type DuplicateDwId = {
  /** The first occurrence's spelling. */
  id: string
  /** Every distinct raw spelling, in file order (e.g. `DW-0276`, `DW-276`). */
  spellings: string[]
  lines: number[]
}

export type NonStandardDwHeadingLevel = { id: string; line: number; level: number }

export type DeferredWorkIdFindings = {
  headingCount: number
  duplicates: DuplicateDwId[]
  nonStandardLevels: NonStandardDwHeadingLevel[]
}

/** Headings minus RESERVED stubs whose ID also has a real entry: that pair is a "leftover stub"
 * (reported by `scanDeferredWorkReservations`), not a true duplicate. */
function withoutLeftoverStubs(headings: DwHeading[], content: string): DwHeading[] {
  const stubLines = new Set(parseReservations(content).map((r) => r.line))
  const realIds = new Set(headings.filter((h) => !stubLines.has(h.line)).map((h) => h.normalizedId))
  return headings.filter((h) => !(stubLines.has(h.line) && realIds.has(h.normalizedId)))
}

function findDuplicates(headings: DwHeading[]): DuplicateDwId[] {
  const byId = new Map<string, DwHeading[]>()
  for (const heading of headings) {
    byId.set(heading.normalizedId, [...(byId.get(heading.normalizedId) ?? []), heading])
  }
  return [...byId.values()]
    .filter((occurrences) => occurrences.length > 1)
    .map((occurrences) => ({
      id: (occurrences[0] as DwHeading).id,
      spellings: [...new Set(occurrences.map((o) => o.id))],
      lines: occurrences.map((o) => o.line),
    }))
}

/** Scans `deferred-work.md` under `rootDir`; an unreadable ledger yields no findings (the CLI
 * reports it as SKIPPED before ever calling this). */
export function scanDeferredWorkIds(rootDir = process.cwd()): DeferredWorkIdFindings {
  const content = readOverlayFile(rootDir, DEFERRED_WORK_PATH)
  if (content === undefined) return { headingCount: 0, duplicates: [], nonStandardLevels: [] }

  const headings = parseDwHeadings(content)
  return {
    headingCount: headings.length,
    duplicates: findDuplicates(withoutLeftoverStubs(headings, content)),
    nonStandardLevels: headings
      .filter((h) => h.level !== 3)
      .map(({ id, line, level }) => ({ id, line, level })),
  }
}

export type StaleReservation = { id: string; line: number; story: string; date: string }
export type LeftoverReservation = { id: string; stubLine: number; entryLines: number[] }
export type UnparsableReservation = { id: string; line: number; story: string; text: string }
export type ReservationFindings = {
  stale: StaleReservation[]
  leftover: LeftoverReservation[]
  unparsable: UnparsableReservation[]
}

/**
 * Story 66-19 AC-2: RESERVED stubs (`next-dw-id --reserve`). Stale (older than
 * RESERVATION_STALE_DAYS) and unparsable-timestamp stubs are FATAL, as is a stub whose ID also has
 * a real entry ("leftover stub"). Fresh stubs pass. Rule lives here, in the already-wired guard,
 * rather than in a new script: same ledger, same parser, one fewer package/Makefile/ci entry.
 */
export function scanDeferredWorkReservations(
  rootDir = process.cwd(),
  now = new Date()
): ReservationFindings {
  const findings: ReservationFindings = { stale: [], leftover: [], unparsable: [] }
  const content = readOverlayFile(rootDir, DEFERRED_WORK_PATH)
  if (content === undefined) return findings

  const headings = parseDwHeadings(content)
  const reservations = parseReservations(content)
  const stubLines = new Set(reservations.map((r) => r.line))
  const staleAfterMs = RESERVATION_STALE_DAYS * 86_400_000
  for (const r of reservations) {
    const entryLines = headings
      .filter((h) => h.normalizedId === r.normalizedId && !stubLines.has(h.line))
      .map((h) => h.line)
    if (entryLines.length > 0) {
      findings.leftover.push({ id: r.id, stubLine: r.line, entryLines })
    }
    if (r.timestampMs === undefined) {
      findings.unparsable.push({ id: r.id, line: r.line, story: r.story, text: r.timestampText })
    } else if (now.getTime() - r.timestampMs > staleAfterMs) {
      findings.stale.push({
        id: r.id,
        line: r.line,
        story: r.story,
        date: new Date(r.timestampMs).toISOString().slice(0, 10),
      })
    }
  }
  return findings
}

function reportReservations(findings: ReservationFindings): void {
  for (const s of findings.stale) {
    process.stderr.write(
      `FATAL: ${DEFERRED_WORK_PATH}:${s.line}: ${s.id} reserved by ${s.story} on ${s.date}, never ` +
        'filled in; write the entry or delete the stub (`### DW-<n>: RESERVED ...`).\n'
    )
  }
  for (const u of findings.unparsable) {
    process.stderr.write(
      `FATAL: ${DEFERRED_WORK_PATH}:${u.line}: ${u.id} reservation by ${u.story} has an ` +
        `unparsable timestamp (${JSON.stringify(u.text)}); expected ISO-8601 UTC. Fix or delete the stub.\n`
    )
  }
  for (const l of findings.leftover) {
    process.stderr.write(
      `FATAL: ${DEFERRED_WORK_PATH}:${l.stubLine}: leftover stub: ${l.id} has a real entry` +
        `${formatLineRefs(l.entryLines)} and a RESERVED stub (not a true duplicate); delete the ` +
        'stub (replaceReservation swaps it for the entry).\n'
    )
  }
}

function reservationsClean(findings: ReservationFindings): boolean {
  return findings.stale.length + findings.leftover.length + findings.unparsable.length === 0
}

function reportDuplicates(duplicates: DuplicateDwId[]): void {
  if (duplicates.length === 0) return
  process.stderr.write(
    'FATAL: deferred-work.md declares the same DW ID more than once (epic-43 retro Finding 2):\n'
  )
  for (const d of duplicates) {
    process.stderr.write(
      `  - ${d.spellings.join(' / ')}: ${DEFERRED_WORK_PATH}${formatLineRefs(d.lines)}\n`
    )
  }
  const example = duplicates.length === 1 ? (duplicates[0] as DuplicateDwId).id : 'DW-<n>'
  process.stderr.write(
    '\nFix: renumber the NEWER entry to the next free ID (`pnpm next-dw-id --fetch`), add a ' +
      `\`renumbered: originally filed as ${example} ...\` line to it, and update every reference ` +
      '(story files, sprint-status.yaml comments, other DW entries).\n'
  )
}

function reportNonStandardLevels(nonStandard: NonStandardDwHeadingLevel[]): void {
  if (nonStandard.length === 0) return
  process.stderr.write(
    'FATAL: deferred-work.md has a DW entry heading that is not a `###` heading ' +
      '(check-cross-repo-dw-closure and bmad-loop-sweep only see `### DW-` entries):\n'
  )
  for (const n of nonStandard) {
    process.stderr.write(
      `  - ${DEFERRED_WORK_PATH}:${n.line}: ${n.id} is a level-${n.level} heading ` +
        `(${'#'.repeat(n.level)}); DW entries must be ### headings\n`
    )
  }
  process.stderr.write('\nFix: change the heading to `### DW-<id>: <title>`.\n')
}

function report(findings: DeferredWorkIdFindings, reservations: ReservationFindings): void {
  if (!reservationsClean(reservations)) {
    reportReservations(reservations)
    process.exitCode = 1
  }
  if (findings.duplicates.length === 0 && findings.nonStandardLevels.length === 0) {
    if (!reservationsClean(reservations)) return
    process.stdout.write(
      `check-deferred-work-ids: ${findings.headingCount} DW entry headings, all IDs unique — OK\n`
    )
    return
  }
  reportDuplicates(findings.duplicates)
  if (findings.duplicates.length > 0 && findings.nonStandardLevels.length > 0) {
    process.stderr.write('\n')
  }
  reportNonStandardLevels(findings.nonStandardLevels)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runOverlayGuard(
    'check-deferred-work-ids',
    process.cwd(),
    DEFERRED_WORK_PATH,
    () => {
      report(scanDeferredWorkIds(), scanDeferredWorkReservations())
    },
    DEFERRED_WORK_SHAPE
  )
}
