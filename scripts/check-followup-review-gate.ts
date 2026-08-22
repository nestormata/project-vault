#!/usr/bin/env tsx
/**
 * A21-1 enforcement — Story 22.7. `followup_review_recommended: true` has, four separate times
 * now (`21-5`, `22-1`, `22-2`, `20-5`), shipped to `done` in `sprint-status.yaml` with the flag
 * still set, no follow-up review ever run, and no written waiver — caught only by a retro's
 * manual sweep, well after the fact. This is the closure-time build failure that closes the gap:
 * every `done` story with the flag set must carry a matching `deferred-work.md` ledger entry or
 * an explicit waiver, or this check fails the build.
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'
import { evaluateFollowupReviewGate } from './lib/followup-review-gate.js'
import { toRepoPath } from './lib/scan-utils.js'

export type FollowupReviewGateViolation = {
  storyKey: string
  storyFile: string
}

const STORIES_DIR = '_bmad-output/implementation-artifacts'
const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'

/** Real story keys have the `<epic>-<story>-<slug>` shape — skip epic/retrospective/other keys. */
const STORY_KEY_PATTERN = /^\d+-\d+-/

export function scanFollowupReviewGate(rootDir = process.cwd()): FollowupReviewGateViolation[] {
  const root = resolve(rootDir)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return []

  let deferredWorkContent = ''
  try {
    deferredWorkContent = readFileSync(resolve(root, DEFERRED_WORK_PATH), 'utf-8')
  } catch {
    // deferred-work.md not found — can't verify tracking; fail open (don't block builds),
    // matching check-psc-tbd-tracking.ts's existing convention.
    return []
  }

  const violations: FollowupReviewGateViolation[] = []
  for (const [storyKey, status] of sprintStatuses) {
    if (!STORY_KEY_PATTERN.test(storyKey)) continue
    if (status !== 'done') continue

    const storyFilePath = resolve(root, STORIES_DIR, `${storyKey}.md`)
    let content: string
    try {
      content = readFileSync(storyFilePath, 'utf-8')
    } catch {
      // Story key tracked in sprint-status.yaml but no matching file on disk — nothing to
      // evaluate; skip rather than crash the check over an unrelated integrity gap.
      continue
    }

    const verdict = evaluateFollowupReviewGate(storyKey, status, content, deferredWorkContent)
    if (verdict === 'block') {
      violations.push({ storyKey, storyFile: toRepoPath(root, storyFilePath) })
    }
  }

  return violations.sort((a, b) => a.storyKey.localeCompare(b.storyKey))
}

function report(violations: FollowupReviewGateViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-followup-review-gate: all followup_review_recommended flags on done stories are tracked or waived — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: story file(s) have `followup_review_recommended: true`, are `done` in sprint-status.yaml,\n' +
      'and have neither a matching deferred-work.md ledger entry nor a written waiver (A21-1 enforcement):\n\n'
  )
  for (const v of violations) {
    process.stderr.write(
      `  - ${v.storyKey} (${v.storyFile})\n` +
        '    Remediation — do exactly one of:\n' +
        '      1. Run the follow-up review and set followup_review_recommended: false in the story file.\n' +
        '      2. Add a deferred-work.md entry whose source_spec (or title) names this exact story key.\n' +
        '      3. Add a written followup_review_waiver: "<who, why, date>" to the story frontmatter.\n'
    )
  }
  process.stderr.write('\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanFollowupReviewGate())
}
