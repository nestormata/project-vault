#!/usr/bin/env tsx
/**
 * P7-1/P8-2 — A Product Surface Contract `TBD` "Linked UI story" deferral inside a story file
 * must have a corresponding entry in deferred-work.md's "Web UI gaps" table. The same gap
 * (PSC TBD prose with no tracked deferred-work.md row) has been caught by manual retro sweeps
 * four epics running (Epic 5 P5-2, Epic 6 A6-1, Epic 7 A7-1, Epic 8 Finding #2) because nothing
 * failed a build over it. This is that build failure.
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'

export type PscTbdViolation = {
  storyKey: string
  storyFile: string
  storyStatus: string
}

const STORIES_DIR = '_bmad-output/implementation-artifacts'
const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'

/** Statuses indicating the story is actively tracked — TBD PSC on any of these must be in deferred-work.md. */
const ACTIVE_STATUSES = new Set(['ready-for-dev', 'in-progress', 'review', 'done'])

/** True if the story file contains a PSC "Linked UI story" row whose value is `TBD`. */
export function hasPscTbd(content: string): boolean {
  // Matches the markdown table row: `| **Linked UI story** ... | `TBD` ... |`
  return /\|\s*\*\*Linked UI story\*\*[^|]*\|\s*`TBD`/.test(content)
}

/**
 * True if deferred-work.md's "Web UI gaps" section already references this story.
 * Story keys use hyphen notation (e.g. "9-1"); deferred-work.md rows use dot notation
 * (e.g. "9.1") — both forms are checked.
 */
export function isTrackedInDeferredWork(storyKey: string, deferredWorkContent: string): boolean {
  const numericMatch = storyKey.match(/^(\d+)-(\d+)/)
  if (!numericMatch) return true // can't determine; skip to avoid false positives

  const epicNum = numericMatch[1]
  const storyNum = numericMatch[2]
  if (!epicNum || !storyNum) return true

  const hyphenForm = `${epicNum}-${storyNum}` // e.g. "9-1"
  const dotForm = `${epicNum}.${storyNum}` // e.g. "9.1"

  // Extract only the "Web UI gaps" section so we don't match unrelated prose elsewhere
  const webUiGapsMatch = deferredWorkContent.match(/###\s*Web UI gaps[\s\S]*?(?=\n###|\n##|$)/)
  if (!webUiGapsMatch) return false

  const section = webUiGapsMatch[0]
  return section.includes(hyphenForm) || section.includes(dotForm)
}

export function scanPscTbdTracking(rootDir = process.cwd()): PscTbdViolation[] {
  const root = resolve(rootDir)
  const storiesDir = resolve(root, STORIES_DIR)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return []

  let deferredWorkContent = ''
  try {
    deferredWorkContent = readFileSync(resolve(root, DEFERRED_WORK_PATH), 'utf-8')
  } catch {
    // deferred-work.md not found — can't verify tracking; fail open (don't block builds)
    return []
  }

  const violations: PscTbdViolation[] = []
  for (const file of walkFiles(storiesDir, (path) => path.endsWith('.md'))) {
    const storyKey = basename(file, '.md')
    const storyStatus = sprintStatuses.get(storyKey)
    // Not a tracked story key or not an active story — skip
    if (!storyStatus || !ACTIVE_STATUSES.has(storyStatus)) continue

    const content = readFileSync(file, 'utf-8')
    if (!hasPscTbd(content)) continue

    if (!isTrackedInDeferredWork(storyKey, deferredWorkContent)) {
      violations.push({ storyKey, storyFile: toRepoPath(root, file), storyStatus })
    }
  }

  return violations.sort((a, b) => a.storyKey.localeCompare(b.storyKey))
}

function report(violations: PscTbdViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-psc-tbd-tracking: all PSC TBD UI deferrals are tracked in deferred-work.md — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: story file(s) have a Product Surface Contract `TBD` "Linked UI story" entry\n' +
      'with no matching row in deferred-work.md\'s "Web UI gaps" table (P7-1/P8-2 enforcement):\n\n'
  )
  for (const v of violations) {
    process.stderr.write(
      `  - ${v.storyFile} (status: ${v.storyStatus})\n` +
        '    PSC "Linked UI story" = TBD but no deferred-work.md "Web UI gaps" row found\n'
    )
  }
  process.stderr.write(
    '\nFix: add a row to deferred-work.md\'s "### Web UI gaps" table for each story above,\n' +
      'or mark an existing row "Resolved" with the follow-up story reference.\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanPscTbdTracking())
}
