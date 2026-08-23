#!/usr/bin/env tsx
/**
 * P6-1/P7-1/P8-1 — the same drift (a story file's `Status:` header disagreeing with its
 * `sprint-status.yaml` entry) has been caught by manual retro sweeps three epics running, because
 * nothing failed a build over it. This is that build failure.
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'

export type StatusMismatch = {
  storyKey: string
  storyFile: string
  storyStatus: string
  sprintStatus: string
}

const SPRINT_STATUS_PATH = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const STORIES_DIR = '_bmad-output/implementation-artifacts'

/** Parses only the `development_status:` block's flat `key: value` entries — not a general YAML parser. */
export function parseDevelopmentStatus(yamlContent: string): Map<string, string> {
  const statuses = new Map<string, string>()
  let inBlock = false

  for (const line of yamlContent.split('\n')) {
    if (/^development_status:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (line.length > 0 && !/^\s/.test(line)) break // dedented back to top level — block ended

    const match = /^\s{2}([a-zA-Z0-9_-]+):\s*(\S+)/.exec(line)
    if (match) statuses.set(match[1] as string, match[2] as string)
  }

  return statuses
}

export function loadSprintStatuses(rootDir: string): Map<string, string> | null {
  try {
    return parseDevelopmentStatus(readFileSync(resolve(rootDir, SPRINT_STATUS_PATH), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Extracts the status token from the first `Status:` line in a story file. Many story files
 * follow the plain `Status: done` convention, but an established, equally common convention in
 * this project puts explanatory prose after the status word on the same line (e.g. `Status:
 * review — implementation completed 2026-08-19 after...`, `Status: done (targeted review and
 * quality gate complete; ...)`). The prior regex required the whole line to be nothing but the
 * status word, so any annotated `Status:` line silently produced no match at all — not a
 * mismatch, just invisible to this guard (found live on `23-5`, Epic 23's retro, 2026-08-23: a
 * `Status: review — ...` header sitting undetected against a `done` sprint-status.yaml entry for
 * 5 days). Capturing only the first non-whitespace token — not requiring end-of-line — catches
 * both conventions.
 */
function extractStoryFileStatus(content: string): string | undefined {
  return /^Status:\s*(\S+)/m.exec(content)?.[1]
}

export function scanStoryStatusSync(rootDir = process.cwd()): StatusMismatch[] {
  const root = resolve(rootDir)
  const storiesDir = resolve(root, STORIES_DIR)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return []

  const mismatches: StatusMismatch[] = []
  for (const file of walkFiles(storiesDir, (path) => path.endsWith('.md'))) {
    const storyKey = basename(file, '.md')
    const sprintStatus = sprintStatuses.get(storyKey)
    // Not a tracked story key — an adversarial-review file, retro doc, deferred-work.md, etc.
    if (sprintStatus === undefined) continue

    const storyStatus = extractStoryFileStatus(readFileSync(file, 'utf-8'))
    if (storyStatus !== undefined && storyStatus !== sprintStatus) {
      mismatches.push({ storyKey, storyFile: toRepoPath(root, file), storyStatus, sprintStatus })
    }
  }

  return mismatches.sort((a, b) => a.storyKey.localeCompare(b.storyKey))
}

function report(mismatches: StatusMismatch[]): void {
  if (mismatches.length === 0) {
    process.stdout.write(
      'check-story-status-sync: every story file Status: header matches sprint-status.yaml — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: story file `Status:` header does not match sprint-status.yaml (P6-1/P7-1/P8-1 drift):\n'
  )
  for (const m of mismatches) {
    process.stderr.write(
      `  - ${m.storyFile}: file says "Status: ${m.storyStatus}", sprint-status.yaml says "${m.sprintStatus}"\n`
    )
  }
  process.stderr.write(
    "\nFix: update the story file's `Status:` header to match sprint-status.yaml (or vice versa,\n" +
      "if the yaml is the one that's stale), then re-run.\n"
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanStoryStatusSync())
}
