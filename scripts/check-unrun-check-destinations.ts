#!/usr/bin/env tsx
/**
 * Story 63.4 (epic-63 retro Finding 1 [Critical] [REPEAT 4x]): done stories kept recording a check
 * as "not run" / "not drivable" / "not captured" with no pointer to where it went (63-1, 63-2,
 * 63-3; epic-59, epic-62 and epic-66 before them). pick-story C4 requires a destination; this is
 * its CI half, because the skill text alone failed four times.
 *
 * A story file is read as blocks: a paragraph, a list item or a table row, with its hard-wrapped
 * continuation lines joined. For every `done` story, each block outside the `## Story` section
 * and fenced code that matches an `UNRUN_PHRASES` entry must carry, in the same block, a
 * destination that resolves:
 * - `moved to backlog story <full key>`: a registered sprint-status key other than the story;
 * - `ledgered as DW-<id>`: an entry in deferred-work.md;
 * - `covered by <full key or test file>`: a registered key other than the story, or a test file
 *   (`*.test.*`, `*.spec.*`, or under `e2e/` / `tests/`) inside the repo, outside `_bmad-output/`.
 *
 * History: the private overlay's `unrun-check-baseline.json` maps a story key to the fingerprints
 * of its unresolved blocks from before the rule (2026-10-24). A fingerprint matches one exact
 * block, so editing or adding a line fails; a fingerprint with no matching block fails, so the
 * list only shrinks; and `BASELINE_CEILING` caps its size from this repo.
 *
 * Pure, DB-free: a static scan of the private overlay (sprint-status.yaml, story files,
 * deferred-work.md, unrun-check-baseline.json).
 */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseDevelopmentStatusComments,
  SPRINT_STATUS_PATH,
  SPRINT_STATUS_SHAPE,
} from './check-story-status-sync.js'
import { createFenceTracker, normalizeDwId, parseDwEntries } from './lib/deferred-work-ledger.js'
import { realPath, statPath } from './lib/fs-access.js'
import { readOverlayFile, runOverlayGuards, toRepoPath } from './lib/scan-utils.js'
import { type Heading, parseHeading } from './lib/section-ledger-rules.js'
import { resolveStoryFile } from './lib/story-files.js'
import { citedStoryKeys } from './lib/story-keys.js'

const CHECK_NAME = 'check-unrun-check-destinations'
const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'
export const BASELINE_PATH = '_bmad-output/implementation-artifacts/unrun-check-baseline.json'

/**
 * The most fingerprints the private baseline may hold: the count it shipped with on 2026-10-26.
 * Lower it as stories are backfilled; raising it is a gate exception (expert + Nestor sign-off).
 */
export const BASELINE_CEILING = 207

/**
 * The pick-story C4 step 4 phrase set. "not ..." after a modal or present-tense verb ("do not
 * run", "is not executed when the flag is off") is product or instruction prose, not a record,
 * and "extension cannot" counts only for the Chrome extension, not the extension API.
 */
export const UNRUN_PHRASES: readonly RegExp[] = [
  /\bcould not (?:run|drive)\b/i,
  /(?<!\b(?:do|does|must|should|will|would|may|might|is|are|can|cannot) )\bnot (?:run|drivable|executed|captured)\b/i,
  /\b(?:the|chrome|claude-in-chrome) extension cannot\b/i,
]

const DESTINATION =
  /\b(moved to backlog story|ledgered as|covered by)\s+(\[[^\]]*\]\([^)\s]+\)|\S+)/gi
const MARKDOWN_LINK = /^\[[^\]]*\]\(([^)\s]+)\)/
const TOKEN_EDGES = /^[`'"(*~]+|[`'")\].,;:*~]+$/g
const UNDERSCORE_EMPHASIS = /^_(.+)_$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:e2e|tests?)\//
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const TABLE_ROW = /^\s*\|/
const FINGERPRINT = /^[0-9a-f]{16}$/
const STORY_KEY = /^\d+-\d+[a-z]?-/

export type Baseline = ReadonlyMap<string, readonly string[]>

export type UnrunViolationKind =
  'no-destination' | 'stale-baseline' | 'malformed-baseline' | 'over-ceiling'

export type UnrunViolation = {
  kind: UnrunViolationKind
  path: string
  line: number
  message: string
}

export type UnrunFindings = {
  doneCount: number
  /** Unrun-check blocks whose destination resolved. */
  resolvedCount: number
  /** Unresolved blocks whose fingerprint is in the baseline. */
  grandfathered: number
  violations: UnrunViolation[]
}

/** A paragraph, list item or table row: its first physical line and its joined text. */
export type Block = { line: number; text: string }

export function findUnrunPhrase(text: string): string | undefined {
  for (const phrase of UNRUN_PHRASES) {
    const match = phrase.exec(text)
    if (match) return match[0]
  }
  return undefined
}

/** The fingerprint the baseline stores for a block: whitespace-insensitive, 16 hex chars. */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text.replaceAll(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

type ClassifiedLine = { line: number; text: string; heading?: Heading; breaks: boolean }

function classifyLines(content: string): ClassifiedLine[] {
  const fenced = createFenceTracker()
  return content.split('\n').map((raw, index) => {
    const text = raw.replace(/\r$/, '')
    const isFence = fenced(text)
    const heading = isFence ? undefined : parseHeading(text)
    const breaks = isFence || text.trim() === '' || heading !== undefined
    return { line: index + 1, text, heading, breaks }
  })
}

/** Drops the `## Story` section: it runs from that heading to the next level 1 or 2 heading. */
function outsideStorySection(lines: ClassifiedLine[]): ClassifiedLine[] {
  let inStory = false
  return lines.filter(({ heading }) => {
    if (heading && heading.level <= 2) inStory = heading.level === 2 && heading.title === 'Story'
    return !inStory
  })
}

const startsBlock = (text: string) => LIST_ITEM.test(text) || TABLE_ROW.test(text)

/** Story blocks outside fenced code and outside the `## Story` section. */
export function storyBlocks(content: string): Block[] {
  const blocks: Block[] = []
  let current: Block | undefined
  for (const { line, text, heading, breaks } of outsideStorySection(classifyLines(content))) {
    if (breaks) {
      current = undefined
      if (heading) blocks.push({ line, text })
    } else if (current && !startsBlock(text)) {
      current.text = `${current.text} ${text.trim()}`
    } else {
      current = { line, text }
      blocks.push(current)
    }
  }
  return blocks
}

type Context = {
  root: string
  realRoot: string
  storyKey: string
  sprintKeys: Set<string>
  dwIds: Set<string>
}

function cleanToken(raw: string): string {
  const link = MARKDOWN_LINK.exec(raw)?.[1]
  const token = (link ?? raw).replaceAll(TOKEN_EDGES, '')
  return UNDERSCORE_EMPHASIS.exec(token)?.[1] ?? token
}

function storyKeyProblem(token: string, context: Context, phrase: string): string | undefined {
  const [key] = citedStoryKeys(token)
  if (key === undefined || key !== token) return `${phrase} "${token}" is not a full story key`
  if (key === context.storyKey) return `${key} is the story itself`
  if (!context.sprintKeys.has(key)) return `${key} is not in sprint-status.yaml`
  return undefined
}

/** Whether `relPath` is a test file inside the repo root (symlinks resolved) and outside the overlay. */
function isRepoTestFile(relPath: string, context: Context): boolean {
  if (isAbsolute(relPath) || !TEST_FILE.test(relPath)) return false
  try {
    const real = realPath(resolve(context.root, relPath))
    if (!real.startsWith(context.realRoot + sep)) return false
    const repoPath = toRepoPath(context.realRoot, real)
    return !repoPath.startsWith('_bmad-output/') && statPath(real).isFile()
  } catch {
    return false
  }
}

function coveredByProblem(token: string, context: Context): string | undefined {
  const [key] = citedStoryKeys(token)
  if (key !== undefined && key === token) return storyKeyProblem(token, context, 'covered by')
  if (isRepoTestFile(token.split(':')[0] as string, context)) return undefined
  return `covered by "${token}" is neither a registered story key nor a test file in the repo`
}

/** `DW-<n>` with optional `.`/`-` numeric segments (`DW-23.2-1`), as the ledger parser reads them. */
function isDwId(token: string): boolean {
  const id = /^DW-(.+)$/i.exec(token)?.[1]
  return id !== undefined && id.split(/[.-]/).every((segment) => /^\d+$/.test(segment))
}

function dwProblem(token: string, context: Context): string | undefined {
  if (!isDwId(token)) return `ledgered as "${token}" is not a DW id`
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

/** `undefined` when a destination in the block resolves; otherwise the reasons none did. */
function blockProblems(text: string, context: Context): string[] | undefined {
  const problems: string[] = []
  for (const match of text.matchAll(DESTINATION)) {
    const problem = destinationProblem(match[1] as string, match[2] as string, context)
    if (problem === undefined) return undefined
    problems.push(problem)
  }
  return problems
}

export type Hit = { line: number; phrase: string; problems: string[]; fingerprint: string }

/** A story's unrun-check blocks with no resolving destination, and the count that resolved. */
export function scanStory(
  content: string,
  context: Context
): { unresolved: Hit[]; resolved: number } {
  const unresolved: Hit[] = []
  let resolved = 0
  for (const block of storyBlocks(content)) {
    const phrase = findUnrunPhrase(block.text)
    if (phrase === undefined) continue
    const problems = blockProblems(block.text, context)
    if (problems === undefined) resolved++
    else
      unresolved.push({ line: block.line, phrase, problems, fingerprint: fingerprint(block.text) })
  }
  return { unresolved, resolved }
}

function malformed(reason: string): UnrunViolation {
  return {
    kind: 'malformed-baseline',
    path: BASELINE_PATH,
    line: 1,
    message: `${BASELINE_PATH} is malformed (${reason}); nothing in it is grandfathered`,
  }
}

function isFingerprintList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && FINGERPRINT.test(v))
  )
}

function parseJson(raw: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(raw) as unknown }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'bad JSON' }
  }
}

/** The private overlay's baseline: absent means empty (fail closed), malformed is a violation. */
export function parseBaseline(raw: string | undefined): {
  baseline: Baseline
  problem?: UnrunViolation
} {
  if (raw === undefined) return { baseline: new Map() }
  const { value, error } = parseJson(raw)
  if (error !== undefined) return { baseline: new Map(), problem: malformed(error) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { baseline: new Map(), problem: malformed('not an object of story key to fingerprints') }
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const bad = entries.find(([, fps]) => !isFingerprintList(fps))
  if (bad) {
    return {
      baseline: new Map(),
      problem: malformed(`${bad[0]} is not a non-empty list of fingerprints`),
    }
  }
  return { baseline: new Map(entries as [string, string[]][]) }
}

function storyViolations(storyKey: string, path: string, hits: Hit[], allowed: readonly string[]) {
  const allowedSet = new Set(allowed)
  const found = new Set(hits.map((hit) => hit.fingerprint))
  const violations: UnrunViolation[] = hits
    .filter((hit) => !allowedSet.has(hit.fingerprint))
    .map((hit) => ({
      kind: 'no-destination' as const,
      path,
      line: hit.line,
      message: `${storyKey}: "${hit.phrase}" names no destination${hit.problems.map((p) => `; ${p}`).join('')}`,
    }))
  for (const stale of allowed.filter((fp) => !found.has(fp))) {
    violations.push({
      kind: 'stale-baseline',
      path: BASELINE_PATH,
      line: 1,
      message: `${storyKey}: baseline fingerprint ${stale} matches no unresolved block any more; remove it`,
    })
  }
  return {
    violations,
    grandfathered: hits.length - violations.filter((v) => v.kind === 'no-destination').length,
  }
}

type ScanInputs = Omit<Context, 'storyKey'> & { baseline: Baseline }

function scanEntry(storyKey: string, inputs: ScanInputs) {
  const storyFile = resolveStoryFile(inputs.root, storyKey)
  if (!storyFile) return undefined
  const path = toRepoPath(inputs.root, storyFile.path)
  const { unresolved, resolved } = scanStory(storyFile.content, { ...inputs, storyKey })
  return {
    resolved,
    ...storyViolations(storyKey, path, unresolved, inputs.baseline.get(storyKey) ?? []),
  }
}

function baselineShapeViolations(
  baseline: Baseline,
  scanned: Set<string>,
  ceiling: number
): UnrunViolation[] {
  const violations: UnrunViolation[] = [...baseline.keys()]
    .filter((key) => !scanned.has(key))
    .map((key) => ({
      kind: 'stale-baseline' as const,
      path: BASELINE_PATH,
      line: 1,
      message: `${key}: in the baseline but not a done story with a story file; remove the entry`,
    }))
  const total = [...baseline.values()].reduce((sum, fps) => sum + fps.length, 0)
  if (total > ceiling) {
    violations.push({
      kind: 'over-ceiling',
      path: BASELINE_PATH,
      line: 1,
      message: `the baseline holds ${total} fingerprints, above BASELINE_CEILING (${ceiling}); new unrun checks need a destination, not a fingerprint`,
    })
  }
  return violations
}

function buildInputs(root: string, sprintKeys: Set<string>, baseline: Baseline): ScanInputs {
  const ledger = readOverlayFile(root, DEFERRED_WORK_PATH) ?? ''
  return {
    root,
    realRoot: realPath(root),
    baseline,
    sprintKeys,
    dwIds: new Set(parseDwEntries(ledger).map((dw) => dw.normalizedId)),
  }
}

/** Scans the overlay under `rootDir` (the CLI reports unreadable inputs before calling this). */
export function scanUnrunCheckDestinations(
  rootDir = process.cwd(),
  ceiling = BASELINE_CEILING
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

  const { baseline, problem } = parseBaseline(readOverlayFile(root, BASELINE_PATH))
  if (problem) findings.violations.push(problem)
  const entries = parseDevelopmentStatusComments(sprint)
  const inputs = buildInputs(root, new Set(entries.map((entry) => entry.key)), baseline)
  const doneKeys = new Set(
    entries.filter(({ key, value }) => value === 'done' && STORY_KEY.test(key)).map((e) => e.key)
  )
  const scanned = new Set<string>()
  for (const key of doneKeys) {
    const result = scanEntry(key, inputs)
    if (!result) continue
    scanned.add(key)
    findings.doneCount++
    findings.resolvedCount += result.resolved
    findings.grandfathered += result.grandfathered
    findings.violations.push(...result.violations)
  }
  findings.violations.push(...baselineShapeViolations(baseline, scanned, ceiling))
  findings.violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return findings
}

const FIX =
  'Fix: in the same paragraph or list item, write `moved to backlog story <full key>` (the human ' +
  'manual-testing story for a leg the Chrome extension cannot drive), `ledgered as DW-<id>` ' +
  '(allocate with `pnpm -s next-dw-id --fetch`), or `covered by <full key or test file path>` (a ' +
  'test that proves the same behaviour). For a stale baseline finding, delete the fingerprint the ' +
  'message names; never add one.'

function report(findings: UnrunFindings): void {
  if (findings.violations.length === 0) {
    process.stdout.write(
      `${CHECK_NAME}: ${findings.doneCount} done stories scanned, ${findings.resolvedCount} ` +
        `unrun-check blocks with destinations, ${findings.grandfathered} grandfathered — OK\n`
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
