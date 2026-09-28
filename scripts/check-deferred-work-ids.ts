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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type DwHeading, parseDwHeadings } from './lib/deferred-work-ledger.js'
import { formatLineRefs, runOverlayGuard } from './lib/scan-utils.js'

export const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'

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
  let content: string
  try {
    content = readFileSync(resolve(rootDir, DEFERRED_WORK_PATH), 'utf-8')
  } catch {
    return { headingCount: 0, duplicates: [], nonStandardLevels: [] }
  }

  const headings = parseDwHeadings(content)
  return {
    headingCount: headings.length,
    duplicates: findDuplicates(headings),
    nonStandardLevels: headings
      .filter((h) => h.level !== 3)
      .map(({ id, line, level }) => ({ id, line, level })),
  }
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

function report(findings: DeferredWorkIdFindings): void {
  if (findings.duplicates.length === 0 && findings.nonStandardLevels.length === 0) {
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
  runOverlayGuard('check-deferred-work-ids', process.cwd(), DEFERRED_WORK_PATH, () => {
    report(scanDeferredWorkIds())
  })
}
