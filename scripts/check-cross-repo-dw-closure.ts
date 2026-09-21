#!/usr/bin/env tsx
/**
 * Story 20.15 — filed from `epic-20-retro-2026-09-21.md`'s Gap & Risk Audit High Finding 2: once a
 * project-vault story ships that some `centralizeme-sass` `deferred-work.md` (DW) entry names as
 * its blocker, nothing procedurally verifies that entry actually gets closed on the CM side — each
 * closure depends solely on a human, or a future session in the *other* repo, separately
 * re-discovering that PV's half already shipped.
 *
 * This script reads `centralizeme-sass`'s `deferred-work.md` from a configurable sibling-repo path
 * and flags any DW entry that (a) names a project-vault story key that is already `done` in this
 * repo's own `sprint-status.yaml`, but (b) is not itself classified RESOLVED (`done`/`closed`/
 * `resolved`/`superseded`) — a likely-stale cross-repo closure.
 *
 * Pure, DB-free: a static read of two files (`sprint-status.yaml` here, `deferred-work.md` in the
 * sibling repo).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSprintStatuses } from './check-story-status-sync.js'

export type CrossRepoDwWarning = {
  dwNumber: string
  storyKey: string
  /** The entry's actual `status:` token, verbatim, or `undefined` if no `status:` line was found. */
  statusToken: string | undefined
}

export type CrossRepoDwScanResult = {
  warnings: CrossRepoDwWarning[]
  skipped: boolean
  skipMessage?: string
}

/** `deferred-work.md`'s observed status vocabulary that represents "this entry's concern is settled". */
const RESOLVED_TOKENS = new Set(['done', 'closed', 'resolved', 'superseded'])

/**
 * `open` and `narrowed` (a deliberate, confirmed exception — "scope reduced", not "closed" — see
 * AC-1 step 5) both classify as NOT RESOLVED, and so does any future, currently-unobserved token:
 * an unrecognized value is treated conservatively, not silently coerced toward passing, mirroring
 * `check-epic-gate.ts`/`check-epic-retro-freshness.ts`'s own convention.
 */
function isResolved(statusToken: string | undefined): boolean {
  return statusToken !== undefined && RESOLVED_TOKENS.has(statusToken.toLowerCase())
}

/**
 * A real project-vault/project-vault-private story key is shaped `<epic>-<story>-<slug>` (AC-1
 * step 4, e.g. `20-12-pv-add-a-hostservices-credential-sharing-facade-hook`). `sprint-status.yaml`'s
 * `development_status:` block also carries non-story rollup/gate keys (`epic-1`, `epic-42-gate`)
 * whose bare `epic-<N>` shape is a common short substring in ordinary prose (e.g. "Epic 1") — those
 * would flood this check with false positives if treated as story keys to substring-match against,
 * so only genuine `<digits>-<digits>-<slug>` keys are collected as candidates.
 */
const STORY_KEY_SHAPE_PATTERN = /^\d+-\d+-/

const DEFAULT_RELATIVE_CM_PATH =
  '../centralizeme-sass/_bmad-output/implementation-artifacts/deferred-work.md'

/**
 * Resolves the target `deferred-work.md` path with precedence CLI flag > env var > default
 * sibling-directory guess (AC-1 step 2). Never validates existence here — that is `scanCrossRepoDwClosure`'s
 * job, so this stays a pure path-resolution function, easy to unit test in isolation (AC-3
 * scenario 9).
 */
export function resolveCmPath(rootDir: string, cliArg?: string): string {
  if (cliArg) return resolve(cliArg)
  const envValue = process.env.CENTRALIZEME_SASS_PATH
  if (envValue) return resolve(envValue)
  return resolve(rootDir, DEFAULT_RELATIVE_CM_PATH)
}

type DwEntry = { dwNumber: string; body: string }

const HEADER_PATTERN = /^### DW-(\d+):/gm

/** Splits `deferred-work.md` content into entries on `^### DW-\d+:` headers (AC-1 step 4). */
function parseDwEntries(content: string): DwEntry[] {
  const matches = [...content.matchAll(HEADER_PATTERN)]
  const entries: DwEntry[] = []
  matches.forEach((match, i) => {
    const start = match.index ?? 0
    const nextMatch = matches[i + 1]
    const end = nextMatch?.index ?? content.length
    entries.push({ dwNumber: match[1] as string, body: content.slice(start, end) })
  })
  return entries
}

const STATUS_LINE_PATTERN = /^status:\s*(\S+)$/gim

/**
 * The last line matching `^status:\s*(\S+)$` inside an entry is authoritative — an entry may log
 * intermediate state changes in its own update log, but the final `status:` line is what a human
 * reading top-to-bottom would trust (AC-1 step 4). Returns `undefined` when no `status:` line is
 * present at all (a malformed/missing case — AC-3 scenario 8).
 */
function extractStatus(body: string): string | undefined {
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  // Reset lastIndex defensively — a fresh RegExp literal per call would also work, but reusing the
  // module-level pattern with an explicit reset avoids re-allocating it on every entry.
  STATUS_LINE_PATTERN.lastIndex = 0
  while ((match = STATUS_LINE_PATTERN.exec(body)) !== null) {
    lastMatch = match
  }
  return lastMatch?.[1]
}

/**
 * Reads the sibling `deferred-work.md` at `cmPath` and reports every entry that names a `done` PV
 * story key while itself classifying as NOT RESOLVED. Fails open (a skip result, never a throw)
 * when `cmPath` does not exist — the expected, common case for any machine without a
 * `centralizeme-sass` checkout, and for CI (AC-1 step 3).
 */
export function scanCrossRepoDwClosure(rootDir: string, cmPath: string): CrossRepoDwScanResult {
  // cmPath is caller-controlled (tests pass a fixture path, production passes a resolved CLI
  // flag/env var/default guess), never user input from an untrusted request.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(cmPath)) {
    return {
      warnings: [],
      skipped: true,
      skipMessage: `centralizeme-sass deferred-work.md not found at ${cmPath} — skipping cross-repo check`,
    }
  }

  const sprintStatuses = loadSprintStatuses(rootDir)
  const doneStoryKeys = sprintStatuses
    ? [...sprintStatuses.entries()]
        .filter(([key, value]) => value === 'done' && STORY_KEY_SHAPE_PATTERN.test(key))
        .map(([key]) => key)
    : []

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
  const content = readFileSync(cmPath, 'utf-8')
  const entries = parseDwEntries(content)

  const warnings: CrossRepoDwWarning[] = []
  for (const entry of entries) {
    // Full story-key substring match, not just the epic-story number prefix — avoids false
    // positives against an unrelated numeric mention (Decision Record: Match granularity).
    const matchedStoryKey = doneStoryKeys.find((key) => entry.body.includes(key))
    if (!matchedStoryKey) continue

    const statusToken = extractStatus(entry.body)
    if (isResolved(statusToken)) continue

    warnings.push({ dwNumber: entry.dwNumber, storyKey: matchedStoryKey, statusToken })
  }

  return { warnings, skipped: false }
}

function formatWarningLine(warning: CrossRepoDwWarning): string {
  const statusDisplay = warning.statusToken ?? 'unparseable (no status: line found)'
  return (
    `WARN: centralizeme-sass DW-${warning.dwNumber} names PV story ${warning.storyKey} (done)` +
    ` but is not closed (status: ${statusDisplay})`
  )
}

function report(result: CrossRepoDwScanResult): void {
  if (result.skipped) {
    process.stdout.write(`${result.skipMessage}\n`)
    return
  }

  if (result.warnings.length === 0) {
    process.stdout.write(
      'check-cross-repo-dw-closure: no stale cross-repo closures found — next good time to' +
        ' re-run: after closing any PV story a centralizeme-sass deferred-work.md entry might name\n'
    )
    return
  }

  for (const warning of result.warnings) {
    process.stdout.write(`${formatWarningLine(warning)}\n`)
  }
}

function parseCliArgs(argv: string[]): { cmPath?: string } {
  const flagIndex = argv.indexOf('--cm-path')
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return { cmPath: argv[flagIndex + 1] }
  }
  return {}
}

// This check is deliberately local-only and never CI-wired (AC-2): `centralizeme-sass`'s
// `deferred-work.md` lives in a different git repository that no CI runner or guaranteed
// contributor machine has checked out, so a hard gate here would either always skip (false sense
// of coverage) or fail unpredictably per-machine — see the story's own "Why this can only ever be
// a best-effort, local, non-blocking check" section. This script is exposed only as a `pnpm`
// script, invoked manually.
function main(): void {
  const rootDir = process.cwd()
  const { cmPath: cliCmPath } = parseCliArgs(process.argv.slice(2))
  const cmPath = resolveCmPath(rootDir, cliCmPath)
  report(scanCrossRepoDwClosure(rootDir, cmPath))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
