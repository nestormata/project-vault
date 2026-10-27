#!/usr/bin/env tsx
/**
 * Story 63.4 (epic-63 retro Finding 1 [Critical] [REPEAT 4x]): done stories kept recording a check
 * as "not run" / "not drivable" / "not captured" with no pointer to where it went (63-1, 63-2,
 * 63-3; epic-59, epic-62 and epic-66 before them). pick-story C4 requires a destination; this is
 * its CI half, because the skill text alone failed four times.
 *
 * For every `done` story key, every line of its story file outside the `## Story` section and
 * fenced code that matches `UNRUN_PHRASE` must carry, on the same line, a destination that
 * resolves:
 * - `moved to backlog story <full key>`: a registered sprint-status key other than the story;
 * - `ledgered as DW-<n>`: an entry in deferred-work.md;
 * - `covered by <full key or file path>`: a registered key other than the story, or a file that
 *   exists under the repo root.
 *
 * History: `unrun-check-baseline.json` holds, per story number, the count of unresolved lines in
 * stories closed before the rule (2026-10-24). The counts must match exactly, so the list can only
 * shrink as stories are backfilled.
 *
 * Pure, DB-free: a static scan of the private overlay (sprint-status.yaml, story files,
 * deferred-work.md).
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseDevelopmentStatusComments,
  SPRINT_STATUS_PATH,
  SPRINT_STATUS_SHAPE,
} from './check-story-status-sync.js'
import { statPath } from './lib/fs-access.js'
import { createFenceTracker, normalizeDwId, parseDwEntries } from './lib/deferred-work-ledger.js'
import { readOverlayFile, runOverlayGuards, toRepoPath } from './lib/scan-utils.js'
import { parseHeading } from './lib/section-ledger-rules.js'
import { resolveStoryFile } from './lib/story-files.js'
import { citedStoryKeys } from './lib/story-keys.js'

const CHECK_NAME = 'check-unrun-check-destinations'
const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'
const STORY_NUMBER = /^\d+-\d+[a-z]?(?=-)/

/** The pick-story C4 step 4 phrase set, word-bounded so "cannot run" is not "not run". */
export const UNRUN_PHRASE =
  /\b(?:not run|not drivable|not executed|not captured|could not (?:run|drive)|extension cannot)\b/i

const DESTINATION = /\b(moved to backlog story|ledgered as|covered by)\s+(\S+)/gi
const TOKEN_EDGES = /^[`'"(]+|[`'")\].,;:]+$/g

export const BASELINE_PATH = 'scripts/unrun-check-baseline.json'

/**
 * The grandfathered counts of the repo being scanned. Read from `rootDir`, like every other input,
 * so a fixture root has none; a real checkout without the file fails closed (no grandfathering).
 */
export function loadBaseline(rootDir: string): ReadonlyMap<string, number> {
  const raw = readOverlayFile(resolve(rootDir), BASELINE_PATH)
  if (raw === undefined) return new Map()
  return new Map(Object.entries(JSON.parse(raw) as Record<string, number>))
}

export type UnrunViolationKind = 'no-destination' | 'over-baseline' | 'stale-baseline'

export type UnrunViolation = {
  kind: UnrunViolationKind
  path: string
  line: number
  message: string
}

export type UnrunFindings = {
  doneCount: number
  /** Unrun-check lines whose destination resolved. */
  resolvedCount: number
  /** Baselined stories skipped because their unresolved count matched. */
  grandfathered: number
  violations: UnrunViolation[]
}

export function findUnrunPhrase(line: string): string | undefined {
  return UNRUN_PHRASE.exec(line)?.[0]
}

type Context = { root: string; storyKey: string; sprintKeys: Set<string>; dwIds: Set<string> }

function cleanToken(raw: string): string {
  return raw.replaceAll(TOKEN_EDGES, '')
}

function storyKeyProblem(token: string, context: Context, phrase: string): string | undefined {
  const [key] = citedStoryKeys(token)
  if (key === undefined || key !== token) return `${phrase} "${token}" is not a full story key`
  if (key === context.storyKey) return `${key} is the story itself`
  if (!context.sprintKeys.has(key)) return `${key} is not in sprint-status.yaml`
  return undefined
}

function isFile(path: string): boolean {
  try {
    return statPath(path).isFile()
  } catch {
    return false
  }
}

function coveredByProblem(token: string, context: Context): string | undefined {
  const [key] = citedStoryKeys(token)
  if (key !== undefined && key === token) return storyKeyProblem(token, context, 'covered by')
  if (isFile(resolve(context.root, token.split(':')[0] as string))) return undefined
  return `covered by "${token}" is neither a registered story key nor an existing file`
}

function dwProblem(token: string, context: Context): string | undefined {
  if (!/^DW-\d+$/i.test(token)) return `ledgered as "${token}" is not a DW-<n> id`
  return context.dwIds.has(normalizeDwId(token)) ? undefined : `${token} is not in deferred-work.md`
}

/** Why one destination does not resolve, or undefined when it does. */
function destinationProblem(phrase: string, raw: string, context: Context): string | undefined {
  const token = cleanToken(raw)
  const kind = phrase.toLowerCase()
  if (kind === 'ledgered as') return dwProblem(token, context)
  if (kind === 'covered by') return coveredByProblem(token, context)
  return storyKeyProblem(token, context, phrase)
}

/** `undefined` when a destination on the line resolves; otherwise the reasons none did. */
function lineProblems(text: string, context: Context): string[] | undefined {
  const problems: string[] = []
  for (const match of text.matchAll(DESTINATION)) {
    const problem = destinationProblem(match[1] as string, match[2] as string, context)
    if (problem === undefined) return undefined
    problems.push(problem)
  }
  return problems
}

type Hit = { line: number; phrase: string; problems: string[] }

/** Every unrun-check line outside `## Story` and fenced code, with its unresolved reasons. */
function scanStory(content: string, context: Context): { unresolved: Hit[]; resolved: number } {
  const fenced = createFenceTracker()
  const unresolved: Hit[] = []
  let resolved = 0
  let inStorySection = false
  for (const [index, raw] of content.split('\n').entries()) {
    const text = raw.replace(/\r$/, '')
    if (fenced(text)) continue
    const heading = parseHeading(text)
    if (heading) inStorySection = heading.level === 2 && heading.title === 'Story'
    const phrase = inStorySection ? undefined : findUnrunPhrase(text)
    if (phrase === undefined) continue
    const problems = lineProblems(text, context)
    if (problems === undefined) resolved++
    else unresolved.push({ line: index + 1, phrase, problems })
  }
  return { unresolved, resolved }
}

function hitMessage(storyKey: string, hit: Hit): string {
  return `${storyKey}: "${hit.phrase}" names no destination${hit.problems.map((p) => `; ${p}`).join('')}`
}

function baselineViolations(
  storyNumber: string,
  path: string,
  storyKey: string,
  hits: Hit[],
  allowed: number
): UnrunViolation[] {
  if (hits.length > allowed) {
    const suffix = ` (${hits.length} unresolved lines, the 2026-10-24 baseline allows ${allowed})`
    return hits.map((hit) => ({
      kind: 'over-baseline' as const,
      path,
      line: hit.line,
      message: `${hitMessage(storyKey, hit)}${suffix}`,
    }))
  }
  const fix = hits.length === 0 ? 'remove the entry' : `lower it to ${hits.length}`
  return [
    {
      kind: 'stale-baseline' as const,
      path,
      line: hits[0]?.line ?? 1,
      message: `${storyNumber}: ${hits.length} unresolved lines, but unrun-check-baseline.json allows ${allowed}; ${fix}`,
    },
  ]
}

function storyViolations(
  storyNumber: string,
  path: string,
  storyKey: string,
  unresolved: Hit[],
  allowed: number | undefined
): UnrunViolation[] {
  if (allowed !== undefined)
    return baselineViolations(storyNumber, path, storyKey, unresolved, allowed)
  return unresolved.map((hit) => ({
    kind: 'no-destination' as const,
    path,
    line: hit.line,
    message: hitMessage(storyKey, hit),
  }))
}

type ScanInputs = Omit<Context, 'storyKey'> & { baseline: ReadonlyMap<string, number> }

/** One done story's contribution, or undefined when it is not a scanned done story. */
function scanEntry(
  entry: { key: string; value: string },
  inputs: ScanInputs
):
  | { storyNumber: string; resolved: number; grandfathered: boolean; violations: UnrunViolation[] }
  | undefined {
  const storyNumber = STORY_NUMBER.exec(entry.key)?.[0]
  if (entry.value !== 'done' || storyNumber === undefined) return undefined
  const storyFile = resolveStoryFile(inputs.root, entry.key)
  if (!storyFile) return undefined
  const path = toRepoPath(inputs.root, storyFile.path)
  const { unresolved, resolved } = scanStory(storyFile.content, { ...inputs, storyKey: entry.key })
  const allowed = inputs.baseline.get(storyNumber)
  if (allowed !== undefined && unresolved.length === allowed) {
    return { storyNumber, resolved, grandfathered: true, violations: [] }
  }
  const violations = storyViolations(storyNumber, path, entry.key, unresolved, allowed)
  return { storyNumber, resolved, grandfathered: false, violations }
}

function staleBaselineEntries(
  baseline: ReadonlyMap<string, number>,
  seenNumbers: Set<string>
): UnrunViolation[] {
  return [...baseline.keys()]
    .filter((storyNumber) => !seenNumbers.has(storyNumber))
    .map((storyNumber) => ({
      kind: 'stale-baseline' as const,
      path: BASELINE_PATH,
      line: 1,
      message: `${storyNumber}: in unrun-check-baseline.json but no done story file has that number; remove the entry`,
    }))
}

/** Scans the overlay under `rootDir` (the CLI reports unreadable inputs before calling this). */
export function scanUnrunCheckDestinations(
  rootDir = process.cwd(),
  baseline: ReadonlyMap<string, number> = loadBaseline(rootDir)
): UnrunFindings {
  const root = resolve(rootDir)
  const findings: UnrunFindings = {
    doneCount: 0,
    resolvedCount: 0,
    grandfathered: 0,
    violations: [],
  }
  const sprint = readOverlayFile(root, SPRINT_STATUS_PATH)
  if (sprint === undefined) return findings

  const entries = parseDevelopmentStatusComments(sprint)
  const ledger = readOverlayFile(root, DEFERRED_WORK_PATH) ?? ''
  const inputs: ScanInputs = {
    root,
    baseline,
    sprintKeys: new Set(entries.map((entry) => entry.key)),
    dwIds: new Set(parseDwEntries(ledger).map((dw) => dw.normalizedId)),
  }
  const seenNumbers = new Set<string>()
  for (const entry of entries) {
    const result = scanEntry(entry, inputs)
    if (!result) continue
    findings.doneCount++
    seenNumbers.add(result.storyNumber)
    findings.resolvedCount += result.resolved
    if (result.grandfathered) findings.grandfathered++
    findings.violations.push(...result.violations)
  }
  findings.violations.push(...staleBaselineEntries(baseline, seenNumbers))
  findings.violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return findings
}

const FIX =
  'Fix: on the same line, write `moved to backlog story <full key>` (the human manual-testing story ' +
  'for a leg the Chrome extension cannot drive), `ledgered as DW-<n>` (allocate with ' +
  '`pnpm -s next-dw-id --fetch`), or `covered by <full key or repo file path>` (a test that proves ' +
  'the same behaviour). For a baseline finding, edit scripts/unrun-check-baseline.json ' +
  'as the message says; never raise a count.'

function report(findings: UnrunFindings): void {
  if (findings.violations.length === 0) {
    process.stdout.write(
      `${CHECK_NAME}: ${findings.doneCount} done stories scanned, ${findings.resolvedCount} ` +
        `unrun-check lines with destinations, ${findings.grandfathered} grandfathered — OK\n`
    )
    return
  }
  const lines = findings.violations.map((v) => `  - ${v.path}:${v.line}: ${v.message}`)
  process.stderr.write(
    [
      'FATAL: done stories record a check that was not run without naming where it went ' +
        '(epic-63 retro Finding 1):',
      ...lines,
      '',
      FIX,
    ].join('\n') + '\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  runOverlayGuards(
    CHECK_NAME,
    root,
    [{ relPath: SPRINT_STATUS_PATH, shape: SPRINT_STATUS_SHAPE }, { relPath: DEFERRED_WORK_PATH }],
    () => report(scanUnrunCheckDestinations(root))
  )
}
