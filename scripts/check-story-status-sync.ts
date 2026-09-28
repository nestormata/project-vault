#!/usr/bin/env tsx
/**
 * P6-1/P7-1/P8-1 — the same drift (a story file's `Status:` header disagreeing with its
 * `sprint-status.yaml` entry) has been caught by manual retro sweeps three epics running, because
 * nothing failed a build over it. This is that build failure.
 *
 * Story 43.11 (epic-43 retro Finding 7, epic-59 retro Finding 3): the YAML frontmatter `status:`
 * drifted the same way (43-2, 58-2, 59-1 and 8 more) while the body header was already synced, so
 * the frontmatter is now compared too. When sprint-status.yaml is absent or a dangling overlay
 * symlink, the CLI prints SKIPPED instead of a false OK (AC-7).
 *
 * Pure, DB-free: a static file scan over `_bmad-output/implementation-artifacts/`.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type DanglingSymlinkViolation,
  overlaySkipMessage,
  reportDanglingSymlinks,
  toDanglingSymlinkViolation,
  toRepoPath,
  walkFiles,
} from './lib/scan-utils.js'

export type StatusMismatch = {
  storyKey: string
  storyFile: string
  storyStatus: string
  sprintStatus: string
}

/**
 * Story 43.11 (epic-43 retro Finding 7, epic-59 retro Finding 3): a story file's YAML frontmatter
 * `status:` disagreeing with sprint-status.yaml — the half of the drift the `Status:` header check
 * never saw. Carries an explicit `kind` discriminant; `StatusMismatch` keeps its original shape.
 */
export type FrontmatterStatusMismatch = {
  kind: 'frontmatter-status'
  storyKey: string
  storyFile: string
  /** 1-based line of the `status:` line in the whole file. */
  line: number
  /** The whole `status:` line as written (quoting kept, so the fixer knows which to preserve). */
  frontmatterRaw: string
  frontmatterStatus: string
  sprintStatus: string
  headerStatus: string | undefined
}

/** A story-status-sync finding: a `Status:` header mismatch, a frontmatter `status:` mismatch, or
 * a dangling symlink under implementation-artifacts/ (Story 55.7 AC-2 — reported as its own kind,
 * not folded into `StatusMismatch`). */
export type StoryStatusSyncViolation =
  StatusMismatch | FrontmatterStatusMismatch | DanglingSymlinkViolation

export const SPRINT_STATUS_PATH = '_bmad-output/implementation-artifacts/sprint-status.yaml'
const STORIES_DIR = '_bmad-output/implementation-artifacts'

/** One `development_status:` entry with its 1-based line number in the file (Story 43.11). */
export type DevelopmentStatusEntry = { key: string; value: string; line: number }

/**
 * Parses only the `development_status:` block's flat `key: value` entries, in file order and
 * keeping duplicates (a duplicate key is its own violation, Story 43.11 AC-1 edge case 11) — not a
 * general YAML parser.
 */
export function parseDevelopmentStatusEntries(yamlContent: string): DevelopmentStatusEntry[] {
  const entries: DevelopmentStatusEntry[] = []
  let inBlock = false

  for (const [index, line] of yamlContent.split('\n').entries()) {
    if (/^development_status:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    // Story 55.7 (AC-6): a genuinely dedented, non-comment, non-blank line ends the block (real
    // YAML structure) — but `sprint-status.yaml`'s real convention interleaves column-0
    // `# last_updated: ...` narrative comments *inside* the development_status: block itself, not
    // only before it (confirmed at sprint-status.yaml:765). A `#`-prefixed line is never
    // structural in YAML at any indentation, so it must be skipped like a blank line rather than
    // treated as the block's end.
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith('#')) break

    const match = /^\s{2}([a-zA-Z0-9_-]+):\s*(\S+)/.exec(line)
    if (match) entries.push({ key: match[1] as string, value: match[2] as string, line: index + 1 })
  }

  return entries
}

function toStatusMap(entries: DevelopmentStatusEntry[]): Map<string, string> {
  return new Map(entries.map(({ key, value }) => [key, value]))
}

/** The last-wins `key -> value` view over `parseDevelopmentStatusEntries` (the two cannot drift). */
export function parseDevelopmentStatus(yamlContent: string): Map<string, string> {
  return toStatusMap(parseDevelopmentStatusEntries(yamlContent))
}

export function loadSprintStatusEntries(rootDir: string): DevelopmentStatusEntry[] | null {
  try {
    return parseDevelopmentStatusEntries(
      readFileSync(resolve(rootDir, SPRINT_STATUS_PATH), 'utf-8')
    )
  } catch {
    return null
  }
}

export function loadSprintStatuses(rootDir: string): Map<string, string> | null {
  const entries = loadSprintStatusEntries(rootDir)
  return entries && toStatusMap(entries)
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

/** `'it''s'` -> `it's`; returns the unquoted text, or the rest without the opening quote when the
 * quote is never closed. */
function unquote(value: string): string {
  const quote = value.charAt(0)
  let text = ''
  let i = 1
  while (i < value.length) {
    const ch = value.charAt(i)
    if (ch !== quote) {
      text += ch
    } else if (quote === "'" && value.charAt(i + 1) === "'") {
      text += "'"
      i++
    } else {
      return text
    }
    i++
  }
  return value.slice(1)
}

/** Story 43.11 AC-3 value normalization: quoted text, else the text before a ` #comment`; then the
 * first whitespace-delimited token (mirrors `extractStoryFileStatus`'s first-token rule). */
function normalizeFrontmatterValue(rawValue: string): string {
  const trimmed = rawValue.trim()
  const text =
    trimmed.startsWith("'") || trimmed.startsWith('"')
      ? unquote(trimmed)
      : trimmed.replace(/\s#.*$/, '')
  return text.trim().split(/\s+/)[0] ?? ''
}

/** Index of the frontmatter block's closing `---` line, or undefined when the file has none. */
function frontmatterClose(lines: string[]): number | undefined {
  if (lines[0] !== '---') return undefined
  const close = lines.indexOf('---', 1)
  return close > 0 ? close : undefined
}

/**
 * Story 43.11 AC-3: the first top-level `status:` key of a YAML frontmatter block (first line
 * exactly `---`, BOM/CR tolerated, closed by a later `---` line). Indented keys, a capitalised
 * `Status:`, and anything outside the block are ignored. `line` is 1-based in the whole file.
 */
export function extractFrontmatterStatus(
  content: string
): { raw: string; value: string; line: number } | undefined {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
  const close = frontmatterClose(lines)
  if (close === undefined) return undefined

  for (const [offset, line] of lines.slice(1, close).entries()) {
    const match = /^status:(.*)$/.exec(line)
    if (match) {
      return {
        raw: line.trimEnd(),
        value: normalizeFrontmatterValue(match[1] as string),
        line: offset + 2,
      }
    }
  }
  return undefined
}

function isFrontmatterMismatch(v: StoryStatusSyncViolation): v is FrontmatterStatusMismatch {
  return 'kind' in v
}

function isHeaderMismatch(v: StoryStatusSyncViolation): v is StatusMismatch {
  return 'storyStatus' in v
}

function sortKey(v: StoryStatusSyncViolation): string {
  return 'storyKey' in v ? v.storyKey : v.file
}

function checkStoryFile(
  root: string,
  file: string,
  storyKey: string,
  sprintStatus: string
): StoryStatusSyncViolation[] {
  const content = readFileSync(file, 'utf-8')
  const storyFile = toRepoPath(root, file)
  const found: StoryStatusSyncViolation[] = []

  const storyStatus = extractStoryFileStatus(content)
  if (storyStatus !== undefined && storyStatus !== sprintStatus) {
    found.push({ storyKey, storyFile, storyStatus, sprintStatus })
  }

  const frontmatter = extractFrontmatterStatus(content)
  if (frontmatter !== undefined && frontmatter.value !== sprintStatus) {
    found.push({
      kind: 'frontmatter-status',
      storyKey,
      storyFile,
      line: frontmatter.line,
      frontmatterRaw: frontmatter.raw,
      frontmatterStatus: frontmatter.value,
      sprintStatus,
      headerStatus: storyStatus,
    })
  }
  return found
}

export function scanStoryStatusSync(rootDir = process.cwd()): StoryStatusSyncViolation[] {
  const root = resolve(rootDir)
  const storiesDir = resolve(root, STORIES_DIR)

  const sprintStatuses = loadSprintStatuses(root)
  if (!sprintStatuses) return []

  const violations: StoryStatusSyncViolation[] = []
  const files = walkFiles(
    storiesDir,
    (path) => path.endsWith('.md'),
    (path) => violations.push(toDanglingSymlinkViolation(root, path))
  )

  for (const file of files) {
    const storyKey = basename(file, '.md')
    const sprintStatus = sprintStatuses.get(storyKey)
    // Not a tracked story key — an adversarial-review file, retro doc, deferred-work.md, etc.
    if (sprintStatus === undefined) continue

    violations.push(...checkStoryFile(root, file, storyKey, sprintStatus))
  }

  return violations.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
}

function reportHeaderMismatches(mismatches: StatusMismatch[]): void {
  if (mismatches.length === 0) return
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
}

function reportFrontmatterMismatches(mismatches: FrontmatterStatusMismatch[]): void {
  if (mismatches.length === 0) return
  process.stderr.write(
    'FATAL: story file frontmatter `status:` does not match sprint-status.yaml ' +
      '(epic-43 retro Finding 7 / epic-59 retro Finding 3):\n'
  )
  for (const m of mismatches) {
    const header =
      m.headerStatus === undefined
        ? 'no body Status: header'
        : `body Status: header says "${m.headerStatus}"`
    process.stderr.write(
      `  - ${m.storyFile}:${m.line}: frontmatter says "${m.frontmatterRaw}", ` +
        `sprint-status.yaml says "${m.sprintStatus}" (${header})\n`
    )
  }
  process.stderr.write(
    '\nFix: set the frontmatter `status:` (keep its quoting) AND the body `Status:` header to the ' +
      'sprint-status.yaml value, in the same edit.\n'
  )
}

function report(violations: StoryStatusSyncViolation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-story-status-sync: every story file Status: header and frontmatter status: matches ' +
        'sprint-status.yaml — OK\n'
    )
    return
  }

  reportHeaderMismatches(violations.filter(isHeaderMismatch))
  reportFrontmatterMismatches(violations.filter(isFrontmatterMismatch))
  reportDanglingSymlinks(violations.filter((v): v is DanglingSymlinkViolation => 'reason' in v))

  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const skipped = overlaySkipMessage('check-story-status-sync', process.cwd(), SPRINT_STATUS_PATH)
  if (skipped === undefined) {
    report(scanStoryStatusSync())
  } else {
    process.stdout.write(skipped)
  }
}
