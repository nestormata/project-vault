#!/usr/bin/env tsx
/**
 * A12-3 (Epic 12 retro) asked for a Definition-of-Done check that deferred/incomplete work gets a
 * real, trackable entry, not just prose. Epic 13's retro (Finding 2) found the exact gap this check
 * closes: Story 13.2 twice cited "Story 13.5" as the owner of a known limitation, but no such story
 * existed anywhere — not in sprint-status.yaml, not in epics.md — until Epic 13's own retro scheduled
 * it retroactively. A forward reference to a story number nobody ever created is indistinguishable
 * from a real, tracked deferral until someone goes looking for it. This makes it fail a build instead.
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'
import {
  type DanglingSymlinkViolation,
  reportDanglingSymlinks,
  toDanglingSymlinkViolation,
  toRepoPath,
  walkFiles,
} from './lib/scan-utils.js'

export type DanglingStoryReference = {
  storyKey: string
  storyFile: string
  referencedStory: string
}

/** A story-references finding: either a dangling "Story X.Y" reference or a dangling symlink
 * under implementation-artifacts/ (Story 55.7 AC-2 — reported as its own kind, not folded into
 * `DanglingStoryReference`). */
export type StoryReferenceViolation = DanglingStoryReference | DanglingSymlinkViolation

const STORIES_DIR = '_bmad-output/implementation-artifacts'
const STORY_REFERENCE_PATTERN = /\bStory (\d+)\.(\d+)\b/g

/** Finds "Story X.Y" mentions in `content` that don't resolve to any known sprint-status.yaml key. */
export function findDanglingStoryReferences(
  content: string,
  sprintStatusKeys: Set<string>
): string[] {
  const dangling: string[] = []
  const seen = new Set<string>()

  for (const match of content.matchAll(STORY_REFERENCE_PATTERN)) {
    const [referenced, epic, story] = match
    if (seen.has(referenced)) continue
    seen.add(referenced)

    const prefix = `${epic}-${story}-`
    const exists = [...sprintStatusKeys].some(
      (key) => key === `${epic}-${story}` || key.startsWith(prefix)
    )
    if (!exists) dangling.push(referenced)
  }

  return dangling
}

function sortKey(v: StoryReferenceViolation): [string, string] {
  return 'storyKey' in v ? [v.storyKey, v.referencedStory] : [v.file, '']
}

export function scanStoryReferences(rootDir = process.cwd()): StoryReferenceViolation[] {
  const root = resolve(rootDir)
  const storiesDir = resolve(root, STORIES_DIR)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return []
  const sprintStatusKeys = new Set(sprintStatuses.keys())

  const results: StoryReferenceViolation[] = []
  const files = walkFiles(
    storiesDir,
    (path) => path.endsWith('.md'),
    (path) => results.push(toDanglingSymlinkViolation(root, path))
  )

  for (const file of files) {
    const storyKey = basename(file, '.md')
    // Only scan genuine, tracked story files — not retro docs, adversarial-review docs, or
    // deferred-work.md, which legitimately discuss story numbers that don't exist yet (e.g.
    // scheduling a brand-new backlog story from a retro finding).
    if (!sprintStatusKeys.has(storyKey)) continue

    const content = readFileSync(file, 'utf-8')
    for (const referencedStory of findDanglingStoryReferences(content, sprintStatusKeys)) {
      results.push({ storyKey, storyFile: toRepoPath(root, file), referencedStory })
    }
  }

  return results.sort((a, b) => {
    const [aKey, aRef] = sortKey(a)
    const [bKey, bRef] = sortKey(b)
    return aKey.localeCompare(bKey) || aRef.localeCompare(bRef)
  })
}

function report(violations: StoryReferenceViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-story-references: every "Story X.Y" reference in a story file resolves to a real sprint-status.yaml entry — OK\n'
    )
    return
  }

  const dangling = violations.filter((v): v is DanglingStoryReference => 'storyKey' in v)
  const danglingSymlinks = violations.filter(
    (v): v is DanglingSymlinkViolation => !('storyKey' in v)
  )

  if (dangling.length > 0) {
    process.stderr.write(
      'FATAL: a story file references a story number with no sprint-status.yaml entry (A12-3 gap — a phantom forward reference, same shape as the "Story 13.5" incident):\n'
    )
    for (const d of dangling) {
      process.stderr.write(
        `  - ${d.storyFile}: references "${d.referencedStory}", no such key in sprint-status.yaml\n`
      )
    }
    process.stderr.write(
      '\nFix: either create the referenced story as a real backlog entry in sprint-status.yaml, or\n' +
        'remove the forward reference and log the limitation as a row in\n' +
        '_bmad-output/implementation-artifacts/deferred-work.md instead.\n'
    )
  }

  reportDanglingSymlinks(danglingSymlinks)

  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanStoryReferences())
}
