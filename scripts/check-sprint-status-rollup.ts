#!/usr/bin/env tsx
/**
 * epic-1/epic-6/epic-14/epic-15/epic-16 rollup drift — an `epic-N` rollup key in
 * sprint-status.yaml has drifted stuck at a non-`done` status after every `N-*` story and
 * `epic-N-retrospective` already landed `done`, five times running, caught only by manual retro
 * sweeps because nothing failed a build over it. This is that build failure.
 *
 * Story 43.11 (epic-43 retro Findings 4 and 8) widens the scope to the epic's retrospective key
 * itself: an `epic-N` with child stories but no `epic-N-retrospective` key is FATAL (epics 43-47,
 * 50 and 59 lost theirs unnoticed, because the drift check only looks at a retro that is already
 * `done`), an epic whose children are all done while its retro is not is a WARN (retro due), and a
 * duplicated `development_status` key is FATAL (the parser's last-wins Map silently hides one).
 *
 * Out of scope: verifying a merged PR's target branch reflects each story's real final status
 * post-merge — that needs git/PR context this static scan doesn't have and lives in
 * check-post-merge-status-drift.ts.
 *
 * Pure, DB-free: a static scan over sprint-status.yaml's development_status block.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type DevelopmentStatusEntry,
  loadSprintStatusEntries,
  loadSprintStatuses,
  SPRINT_STATUS_PATH,
} from './check-story-status-sync.js'
import { formatLineRefs, runOverlayGuard } from './lib/scan-utils.js'

export type RollupDrift = {
  epicKey: string
  epicStatus: string
  childKeys: string[]
}

/** Story 43.11 AC-1: an epic with ≥1 child story and no `epic-N-retrospective` key. */
export type MissingRetrospectiveKey = {
  epicKey: string
  epicStatus: string
  /** 1-based line of the `epic-N:` key. */
  line: number
  childKeys: string[]
}

/** Story 43.11 AC-2: every child done, retrospective key present but not `done` (a WARN). */
export type RetroPendingWarning = {
  epicKey: string
  retroStatus: string
  /** 1-based line of the `epic-N-retrospective:` key. */
  line: number
  childKeys: string[]
}

/** Story 43.11 AC-1 edge case 11: a `development_status` key declared more than once. */
export type DuplicateSprintStatusKey = { key: string; lines: number[]; values: string[] }

export type RetroKeyFindings = {
  missing: MissingRetrospectiveKey[]
  pending: RetroPendingWarning[]
  duplicates: DuplicateSprintStatusKey[]
}

type EpicInfo = { epicKey: string; epicNum: string; status: string; childKeys: string[] }

/**
 * Every `epic-<N>` key (`epic-51-gate` and `epic-7-retrospective` are not epic keys) with its
 * child story keys: a key is a child of epic N iff it matches `^<N>-\d+[a-z]*-` (so `51-1-a` is a
 * child of neither `epic-5` nor `epic-151`, and the letter-suffixed `24-5b-...` is a child of
 * `epic-24`). Children are sorted.
 */
function collectEpics(statuses: Map<string, string>): EpicInfo[] {
  const keys = [...statuses.keys()]
  const epics: EpicInfo[] = []
  for (const [epicKey, status] of statuses) {
    const epicMatch = /^epic-(\d+)$/.exec(epicKey)
    if (!epicMatch) continue
    const epicNum = epicMatch[1] as string
    const prefix = `${epicNum}-`
    const childKeys = keys
      .filter((k) => k.startsWith(prefix) && /^\d+[a-z]*-/.test(k.slice(prefix.length)))
      .sort((a, b) => a.localeCompare(b))
    epics.push({ epicKey, epicNum, status, childKeys })
  }
  return epics
}

function epicNumber(epicKey: string): number {
  return Number(/^epic-(\d+)/.exec(epicKey)?.[1] ?? Number.NaN)
}

function byEpicNumber(a: { epicKey: string }, b: { epicKey: string }): number {
  return epicNumber(a.epicKey) - epicNumber(b.epicKey)
}

export function scanSprintStatusRollup(rootDir = process.cwd()): RollupDrift[] {
  const statuses = loadSprintStatuses(resolve(rootDir))
  if (!statuses) return []

  const drifts: RollupDrift[] = []

  for (const { epicKey, epicNum, status, childKeys } of collectEpics(statuses)) {
    if (status === 'done') continue
    if (childKeys.length === 0) continue // nothing to roll up yet — not drift, just not started

    const allChildrenDone = childKeys.every((k) => statuses.get(k) === 'done')
    const retroDone = statuses.get(`epic-${epicNum}-retrospective`) === 'done'

    if (allChildrenDone && retroDone) {
      drifts.push({ epicKey, epicStatus: status, childKeys })
    }
  }

  return drifts.sort((a, b) => a.epicKey.localeCompare(b.epicKey))
}

function findDuplicates(entries: DevelopmentStatusEntry[]): DuplicateSprintStatusKey[] {
  const byKey = new Map<string, DevelopmentStatusEntry[]>()
  for (const entry of entries) {
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry])
  }
  return [...byKey.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([key, occurrences]) => ({
      key,
      lines: occurrences.map((o) => o.line),
      values: occurrences.map((o) => o.value),
    }))
    .sort((a, b) => (a.lines[0] as number) - (b.lines[0] as number))
}

/** The line of a key's last declaration (the one the last-wins Map view reports). */
function lastLineOf(entries: DevelopmentStatusEntry[], key: string): number {
  return entries.findLast((entry) => entry.key === key)?.line ?? 0
}

/**
 * Story 43.11 AC-1/AC-2: retrospective-key findings, independent of the epic's own status (an epic
 * flipped to `done` without a retro key is exactly the Finding 4 hole), plus duplicate keys.
 */
export function scanSprintStatusRetroKeys(rootDir = process.cwd()): RetroKeyFindings {
  const entries = loadSprintStatusEntries(resolve(rootDir))
  const findings: RetroKeyFindings = { missing: [], pending: [], duplicates: [] }
  if (!entries) return findings

  const statuses = new Map(entries.map(({ key, value }) => [key, value]))
  for (const { epicKey, status, childKeys } of collectEpics(statuses)) {
    if (childKeys.length === 0) continue
    const retroKey = `${epicKey}-retrospective`
    const retroStatus = statuses.get(retroKey)
    if (retroStatus === undefined) {
      findings.missing.push({
        epicKey,
        epicStatus: status,
        line: lastLineOf(entries, epicKey),
        childKeys,
      })
    } else if (retroStatus !== 'done' && childKeys.every((k) => statuses.get(k) === 'done')) {
      findings.pending.push({
        epicKey,
        retroStatus,
        line: lastLineOf(entries, retroKey),
        childKeys,
      })
    }
  }

  findings.missing.sort(byEpicNumber)
  findings.pending.sort(byEpicNumber)
  findings.duplicates = findDuplicates(entries)
  return findings
}

function reportDrifts(drifts: RollupDrift[]): void {
  if (drifts.length === 0) return
  process.stderr.write(
    'FATAL: epic-N rollup key is stuck non-done while all its stories + retrospective are done ' +
      '(epic-1/6/14/15/16 rollup-drift pattern):\n'
  )
  for (const d of drifts) {
    process.stderr.write(
      `  - ${d.epicKey}: still "${d.epicStatus}", but ${d.childKeys.join(', ')} and ` +
        `${d.epicKey}-retrospective are all "done"\n`
    )
  }
  process.stderr.write(
    `\nFix: update sprint-status.yaml so the drifted epic-N key(s) above read "done".\n`
  )
}

function reportMissing(missing: MissingRetrospectiveKey[]): void {
  if (missing.length === 0) return
  process.stderr.write(
    'FATAL: epic-N has child stories but no epic-N-retrospective key (epic-43 retro Finding 4):\n'
  )
  for (const m of missing) {
    process.stderr.write(
      `  - ${SPRINT_STATUS_PATH}:${m.line}: ${m.epicKey} (${m.epicStatus}) has ` +
        `${m.childKeys.length} child stories (${m.childKeys.join(', ')}) but no ` +
        `${m.epicKey}-retrospective key\n`
    )
  }
  const retroKey = missing.length === 1 ? `${missing[0]?.epicKey}` : 'epic-N'
  process.stderr.write(
    `\nFix: add \`  ${retroKey}-retrospective: optional\` under the epic's stories in ` +
      'sprint-status.yaml (use `done` only if the retro has actually run).\n'
  )
}

function reportDuplicates(duplicates: DuplicateSprintStatusKey[]): void {
  if (duplicates.length === 0) return
  process.stderr.write(
    'FATAL: sprint-status.yaml declares the same development_status key more than once ' +
      '(the last value silently wins in every guard, hiding the other):\n'
  )
  for (const d of duplicates) {
    const times = d.lines.length === 2 ? 'twice' : `${d.lines.length} times`
    const values = d.values.map((v) => `"${v}"`).join(', ')
    process.stderr.write(
      `  - ${SPRINT_STATUS_PATH}${formatLineRefs(d.lines)}: key "${d.key}" is declared ${times} (${values})\n`
    )
  }
  process.stderr.write(
    '\nFix: keep exactly one line per key, with the correct value (usually a rebase kept both sides).\n'
  )
}

function reportPending(pending: RetroPendingWarning[]): void {
  for (const p of pending) {
    process.stderr.write(
      `WARN: every story of ${p.epicKey} is done but its retrospective is not (retro due):\n` +
        `  - ${SPRINT_STATUS_PATH}:${p.line}: ${p.epicKey}-retrospective is "${p.retroStatus}" ` +
        `(children: ${p.childKeys.join(', ')})\n`
    )
  }
}

function report(drifts: RollupDrift[], retroKeys: RetroKeyFindings): void {
  const fatal = drifts.length + retroKeys.missing.length + retroKeys.duplicates.length > 0

  reportDrifts(drifts)
  reportMissing(retroKeys.missing)
  reportDuplicates(retroKeys.duplicates)
  if (fatal && retroKeys.pending.length > 0) process.stderr.write('\n')
  reportPending(retroKeys.pending)

  if (fatal) {
    process.exitCode = 1
    return
  }
  process.stdout.write(
    'check-sprint-status-rollup: every epic-N rollup key matches its story/retrospective statuses — OK\n'
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runOverlayGuard('check-sprint-status-rollup', process.cwd(), SPRINT_STATUS_PATH, () => {
    report(scanSprintStatusRollup(), scanSprintStatusRetroKeys())
  })
}
