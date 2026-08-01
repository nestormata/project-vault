#!/usr/bin/env tsx
/**
 * Epic 19 follow-through for Epic 18 retro Finding 1.
 *
 * An unchecked code-review finding that explicitly defers work must name a live
 * follow-up story. This prevents review prose such as "deferred for later" from
 * becoming invisible backlog. The check is deliberately narrow: it only scans
 * unchecked `[Review]` bullets with explicit deferral language.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'

export type ReviewDeferralViolation = {
  storyKey: string
  storyFile: string
  line: number
  text: string
}

const STORIES_DIR = '_bmad-output/implementation-artifacts'
const ACTIVE_STATUSES = new Set(['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'])
const REVIEW_ITEM = /^\s*-\s*\[ \]\s+/i
const REVIEW_TAG = /\[Review\]/i
const REVIEW_DEFERRAL_LANGUAGE =
  /\b(?:defer(?:red)?|future|follow[- ]?up|out of scope|not built|left unfixed|left open|unresolved)\b/i
const FOLLOW_UP_KEY = /follow[- ]?up\s*:\s*`?(\d+-\d+-[a-z0-9-]+)`?/i

export function hasTrackedFollowUp(
  line: string,
  sprintStatuses: ReadonlyMap<string, string>
): boolean {
  const match = FOLLOW_UP_KEY.exec(line)
  return match !== null && ACTIVE_STATUSES.has(sprintStatuses.get(match[1]) ?? '')
}

export function findUntrackedReviewDeferrals(
  content: string,
  sprintStatuses: ReadonlyMap<string, string>
): Array<{ line: number; text: string }> {
  return content
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(
      ({ text }) =>
        REVIEW_ITEM.test(text) &&
        REVIEW_TAG.test(text) &&
        REVIEW_DEFERRAL_LANGUAGE.test(text) &&
        !hasTrackedFollowUp(text, sprintStatuses)
    )
}

export function scanStoryReviewDeferrals(rootDir = process.cwd()): ReviewDeferralViolation[] {
  const root = resolve(rootDir)
  const statuses = loadSprintStatuses(root)
  if (!statuses) return []

  const violations: ReviewDeferralViolation[] = []
  for (const file of walkFiles(resolve(root, STORIES_DIR), (path) => path.endsWith('.md'))) {
    const storyKey = basename(file, '.md')
    if (!statuses.has(storyKey) || !ACTIVE_STATUSES.has(statuses.get(storyKey) ?? '')) continue

    const content = readFileSync(file, 'utf8')
    for (const violation of findUntrackedReviewDeferrals(content, statuses)) {
      violations.push({
        storyKey,
        storyFile: toRepoPath(root, file),
        ...violation,
      })
    }
  }

  return violations.sort((a, b) => a.storyKey.localeCompare(b.storyKey) || a.line - b.line)
}

function report(violations: ReviewDeferralViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-story-review-deferrals: all unchecked review deferrals have live follow-ups — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: unchecked [Review] findings contain explicit deferral language without a live follow-up story:\n\n'
  )
  for (const violation of violations) {
    process.stderr.write(
      `  - ${violation.storyFile}:${violation.line} (${violation.storyKey})\n` +
        `    ${violation.text}\n` +
        '    Add `Follow-up: <epic>-<story>-<slug>` and register that key in sprint-status.yaml.\n'
    )
  }
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanStoryReviewDeferrals())
}
