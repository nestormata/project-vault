#!/usr/bin/env tsx
/**
 * epic-1/epic-6/epic-14/epic-15/epic-16 rollup drift — an `epic-N` rollup key in
 * sprint-status.yaml has drifted stuck at a non-`done` status after every `N-*` story and
 * `epic-N-retrospective` already landed `done`, five times running, caught only by manual retro
 * sweeps because nothing failed a build over it. This is that build failure.
 *
 * Scope: this covers only the "epic-N rollup vs. its own story/retro keys" check (1-16's scope
 * item (a)). Scope item (b) — verifying a merged PR's target branch reflects each story's real
 * final status post-merge — needs git/PR context this static scan doesn't have and is intentionally
 * left for a separate nightly/post-merge job, not this pre-merge `make ci` check.
 *
 * Pure, DB-free: a static scan over sprint-status.yaml's development_status block.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDevelopmentStatus } from './check-story-status-sync.js'

const SPRINT_STATUS_PATH = '_bmad-output/implementation-artifacts/sprint-status.yaml'

export type RollupDrift = {
  epicKey: string
  epicStatus: string
  childKeys: string[]
}

function loadSprintStatuses(rootDir: string): Map<string, string> | null {
  try {
    return parseDevelopmentStatus(readFileSync(resolve(rootDir, SPRINT_STATUS_PATH), 'utf-8'))
  } catch {
    return null
  }
}

export function scanSprintStatusRollup(rootDir = process.cwd()): RollupDrift[] {
  const statuses = loadSprintStatuses(resolve(rootDir))
  if (!statuses) return []

  const drifts: RollupDrift[] = []

  for (const [key, status] of statuses) {
    const epicMatch = /^epic-(\d+)$/.exec(key)
    if (!epicMatch) continue
    if (status === 'done') continue

    const epicNum = epicMatch[1]
    const childKeys = [...statuses.keys()].filter((k) => new RegExp(`^${epicNum}-\\d+-`).test(k))
    if (childKeys.length === 0) continue // nothing to roll up yet — not drift, just not started

    const retroKey = `epic-${epicNum}-retrospective`
    const retroStatus = statuses.get(retroKey)

    const allChildrenDone = childKeys.every((k) => statuses.get(k) === 'done')
    const retroDone = retroStatus === 'done'

    if (allChildrenDone && retroDone) {
      drifts.push({ epicKey: key, epicStatus: status, childKeys: childKeys.sort() })
    }
  }

  return drifts.sort((a, b) => a.epicKey.localeCompare(b.epicKey))
}

function report(drifts: RollupDrift[]): void {
  if (drifts.length === 0) {
    process.stdout.write(
      'check-sprint-status-rollup: every epic-N rollup key matches its story/retrospective statuses — OK\n'
    )
    return
  }

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
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanSprintStatusRollup())
}
