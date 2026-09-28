#!/usr/bin/env tsx
/**
 * Story 43.12 (epic-43 retro Finding 1 [Critical] [REPEAT 4x]) — `done` stories kept recording
 * review findings as "documented as accepted tradeoffs" / "left unfixed" in prose only (43-1,
 * 43-3, 43-4, 43-5, and 30 historical stories), so nobody ever revisited them. pick-story C2 says
 * every unfixed finding gets a `deferred-work.md` entry; this is the CI half of that rule.
 *
 * For every `done` story key (`^\d+-\d+[a-z]?-`), the review text is the union of the story
 * file's review sections (level 2-4 headings matching /review/i, minus elicitation / pre-mortem /
 * red team), its Completion Notes section, and its sprint-status.yaml inline comment. FATAL:
 * - a closed trade-off phrase (`TRADEOFF_PHRASES`, or a severity count followed by an unfixed
 *   word) with no DW entry tracking the story: a `source_spec:` naming `<key>.md` /
 *   `spec-<key>.md`, the key in a `### DW-` heading, or a cited `DW-<id>` whose entry names it;
 * - a count ("8 low + 1 medium", N = 9) whose tracking entries itemize fewer than N `(k)` items;
 * - "no deferred-work.md entry needed" in the same text source as a trade-off phrase.
 *
 * Pure, DB-free: a static scan of the private overlay (sprint-status.yaml, story files,
 * deferred-work.md). Unchecked `- [ ] [Review]` deferral bullets stay check-story-review-deferrals'
 * contract (a follow-up story), not this one (a ledger entry).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDevelopmentStatusComments, SPRINT_STATUS_PATH } from './check-story-status-sync.js'
import {
  createFenceTracker,
  type DwEntry,
  extractDwCitations,
  normalizeDwId,
  parseDwEntries,
} from './lib/deferred-work-ledger.js'
import { isTrackedInDeferredWork } from './lib/followup-review-gate.js'
import { runOverlayGuard, toRepoPath } from './lib/scan-utils.js'
import { resolveStoryFile } from './lib/story-files.js'

export const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'
const CHECK_NAME = 'check-review-tradeoff-ledger'
const STORY_KEY_PATTERN = /^\d+-\d+[a-z]?-/

/**
 * The closed trade-off phrase list (AC-1.3), taken from the literal epic-43 retro Finding 1
 * evidence: 43-1 "documented as accepted tradeoffs", 43-4/43-5/25-9 "left as documented
 * tradeoffs", 28-1 "left unfixed", and the "below-threshold" wording of the C2 rule itself. The
 * severity-count phrase (AC-3) is matched separately. Adding a phrase means editing this constant
 * plus a test, and re-measuring the live overlay (a noisy phrase gets a guard routed around).
 */
export const TRADEOFF_PHRASES: readonly RegExp[] = [
  /\bleft unfixed\b/gi,
  /\bleft as (?:(?:documented|accepted) )?trade-?offs?\b/gi,
  /\b(?:accepted|documented) (?:as )?trade-?offs?\b/gi,
  /\bbelow[- ]threshold\b/gi,
]

const NEGATIONS = new Set(['no', 'not', 'none', 'never', 'nothing', 'zero', 'without'])
const NUMBER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]
// `<number> <severity>`, then any `+ / and / , [<number>] <severity>` continuations (AC-3).
const COUNT_START =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:critical|high|medium|med|low|info|nit)s?\b/gi
// A continuation, matched in flat steps (no nested quantifiers): separator, optional number,
// severity.
const COUNT_JOIN_SEPARATOR = /^\s*(?:\+|and\b|\/|,)\s*/i
const COUNT_JOIN_NUMBER =
  /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+/i
const COUNT_JOIN_SEVERITY = /^(?:critical|high|medium|med|low|info|nit)s?\b/i
const UNFIXED_WORD = /\b(?:left|accepted|trade-?offs?|unfixed|below)\b/i
const COUNT_WINDOW = 60
const SENTENCE_SPLIT = /\. |; /
const NO_ENTRY_NEEDED =
  /\bno (?:deferred-work |deferred-work\.md )?(?:ledger )?entry (?:is )?needed\b/i
const ENUMERATOR = /\((\d{1,2})\)/g
const QUOTE_LIMIT = 60

export type TradeoffHit = {
  /** The matched text. */
  text: string
  /** Offset of the match in the line. */
  index: number
  /** For a severity-count hit, the sum of its numbers. */
  findings?: number
}

type BodyLine = { line: number; text: string }

export type ReviewSection = { heading: string; lines: BodyLine[] }

export type TradeoffViolationKind = 'untracked' | 'under-itemized' | 'no-entry-needed'

export type TradeoffViolation = {
  kind: TradeoffViolationKind
  path: string
  line: number
  message: string
}

export type TradeoffFindings = {
  doneCount: number
  hitCount: number
  violations: TradeoffViolation[]
}

/** AC-1.4: whether one of the negation words is among the three words before `index`. */
export function isNegated(sentence: string, index: number): boolean {
  return sentence
    .slice(0, index)
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(-3)
    .some((word) => NEGATIONS.has(word.toLowerCase().replaceAll(/[^a-z]/g, '')))
}

function numberValue(token: string): number {
  const word = NUMBER_WORDS.indexOf(token.toLowerCase())
  return word >= 0 ? word + 1 : Number.parseInt(token, 10)
}

/** One `+ 1 medium` / `/low` continuation at the start of `text`: its length and number (0 when
 * it has none), or undefined. */
function countContinuation(text: string): { length: number; value: number } | undefined {
  const separator = COUNT_JOIN_SEPARATOR.exec(text)
  if (!separator) return undefined
  let length = separator[0].length
  const number = COUNT_JOIN_NUMBER.exec(text.slice(length))
  if (number) length += number[0].length
  const severity = COUNT_JOIN_SEVERITY.exec(text.slice(length))
  if (!severity) return undefined
  return {
    length: length + severity[0].length,
    value: number ? numberValue(number[1] as string) : 0,
  }
}

/** The count phrase starting at `start` (e.g. `8 low + 1 medium`): its end offset and sum. */
function extendCount(sentence: string, start: RegExpExecArray): { end: number; sum: number } {
  let end = start.index + start[0].length
  let sum = numberValue(start[1] as string)
  for (;;) {
    const next = countContinuation(sentence.slice(end))
    if (!next) return { end, sum }
    sum += next.value
    end += next.length
  }
}

function countHits(sentence: string): TradeoffHit[] {
  const hits: TradeoffHit[] = []
  for (const start of sentence.matchAll(COUNT_START)) {
    const { end, sum } = extendCount(sentence, start)
    // A zero count ("0 critical/high left") records that nothing was left, like "zero".
    if (sum > 0 && UNFIXED_WORD.test(sentence.slice(end, end + COUNT_WINDOW))) {
      hits.push({ text: sentence.slice(start.index, end), index: start.index, findings: sum })
    }
  }
  return hits
}

function phraseHits(sentence: string): TradeoffHit[] {
  return TRADEOFF_PHRASES.flatMap((phrase) =>
    [...sentence.matchAll(phrase)].map((m) => ({ text: m[0], index: m.index }))
  )
}

/** AC-1.3/AC-3: every non-negated trade-off hit in one line, in line order. */
export function findTradeoffHits(line: string): TradeoffHit[] {
  const hits: TradeoffHit[] = []
  let offset = 0
  for (const sentence of line.split(SENTENCE_SPLIT)) {
    for (const hit of [...phraseHits(sentence), ...countHits(sentence)]) {
      if (!isNegated(sentence, hit.index)) hits.push({ ...hit, index: hit.index + offset })
    }
    offset += sentence.length + 2
  }
  return withoutOverlaps(hits)
}

/** Line order, longest first at one offset, dropping any hit inside an earlier one (`1 medium`
 * inside `8 low + 1 medium`, `documented tradeoffs` inside `left as documented tradeoffs`). */
function withoutOverlaps(hits: TradeoffHit[]): TradeoffHit[] {
  const kept: TradeoffHit[] = []
  let end = 0
  for (const hit of hits.sort((a, b) => a.index - b.index || b.text.length - a.text.length)) {
    if (hit.index < end) continue
    kept.push(hit)
    end = hit.index + hit.text.length
  }
  return kept
}

type Heading = { level: number; title: string }

function parseHeading(line: string): Heading | undefined {
  const marks = /^(#{1,6})[ \t]+/.exec(line)
  if (!marks) return undefined
  const title = line
    .slice(marks[0].length)
    .replace(/[ \t]#+[ \t]*$/, '')
    .trim()
  return { level: (marks[1] as string).length, title }
}

function isScannedTitle(heading: Heading): boolean {
  if (heading.level < 2 || heading.level > 4) return false
  if (/completion notes/i.test(heading.title)) return true
  return /review/i.test(heading.title) && !/elicitation|pre-?mortem|red team/i.test(heading.title)
}

/** AC-1.2 (a)/(a2): the story file's review and Completion Notes sections, fenced lines left out. */
export function extractReviewSections(content: string): ReviewSection[] {
  const fenced = createFenceTracker()
  const sections: ReviewSection[] = []
  let current: (ReviewSection & { level: number }) | undefined
  for (const [index, rawLine] of content.split('\n').entries()) {
    const text = rawLine.replace(/\r$/, '')
    if (fenced(text)) continue
    const heading = parseHeading(text)
    if (heading && current && heading.level <= current.level) current = undefined
    if (heading && !current && isScannedTitle(heading)) {
      current = {
        heading: `${'#'.repeat(heading.level)} ${heading.title}`,
        lines: [],
        level: heading.level,
      }
      sections.push(current)
      continue
    }
    current?.lines.push({ line: index + 1, text })
  }
  return sections.map(({ heading, lines }) => ({ heading, lines }))
}

/** One place the story's review text lives: a story-file section or its sprint-status comment. */
type TextSource = { path: string; where: string; lines: BodyLine[] }

type LineHit = { path: string; where: string; line: number; hit: TradeoffHit }

type Ledger = { entries: DwEntry[]; byId: Map<string, DwEntry>; entryText: Map<DwEntry, string> }

function loadLedger(content: string): Ledger {
  const contentLines = content.split('\n').map((l) => l.replace(/\r$/, ''))
  const entries = parseDwEntries(content)
  const entryText = new Map(
    entries.map((e) => [e, [contentLines[e.line - 1], ...e.lines.map((l) => l.text)].join('\n')])
  )
  return { entries, byId: new Map(entries.map((e) => [e.normalizedId, e])), entryText }
}

const TOKEN_BEFORE = /[0-9A-Za-z.-]/
const TOKEN_AFTER = /^(?:[0-9A-Za-z]|[.-][0-9A-Za-z])/

/** Whether `token` appears in `text` as a full token (not inside `43-110`, `43-11b` or `143-11`). */
function hasToken(text: string, token: string): boolean {
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const after = text.slice(at + token.length, at + token.length + 2)
    if (!TOKEN_BEFORE.test(text.charAt(at - 1)) && !TOKEN_AFTER.test(after)) return true
  }
  return false
}

/** AC-2 rule 3: an entry names the story by source_spec, full key or story number. */
function entryNamesStory(storyKey: string, text: string): boolean {
  const storyNumber = /^\d+-\d+[a-z]?/.exec(storyKey)?.[0] ?? storyKey
  return (
    isTrackedInDeferredWork(storyKey, text, { allowSpecPrefix: true }) ||
    [storyKey, storyNumber, storyNumber.replace('-', '.')].some((token) => hasToken(text, token))
  )
}

type Tracking = { entries: DwEntry[]; notes: string[] }

/** AC-2: the DW entries tracking a story, plus notes on citations that did not count. */
function trackingEntries(storyKey: string, sources: TextSource[], ledger: Ledger): Tracking {
  const tracking = new Set(
    ledger.entries.filter((e) =>
      isTrackedInDeferredWork(storyKey, ledger.entryText.get(e) ?? '', { allowSpecPrefix: true })
    )
  )
  const notes: string[] = []
  const cited = sources.flatMap((s) => s.lines.flatMap((l) => extractDwCitations(l.text)))
  for (const id of new Set(cited)) {
    const entry = ledger.byId.get(normalizeDwId(id))
    if (!entry) notes.push(`cites ${id}, which is not in deferred-work.md`)
    else if (entryNamesStory(storyKey, ledger.entryText.get(entry) ?? '')) tracking.add(entry)
    else notes.push(`cites ${id}, which does not name this story`)
  }
  return { entries: [...tracking], notes }
}

function itemizedCount(entry: DwEntry): number {
  const numbers = entry.lines.flatMap((l) =>
    [...l.text.matchAll(ENUMERATOR)].map((m) => Number(m[1]))
  )
  return Math.max(0, ...numbers)
}

function quote(text: string): string {
  return `"${text.length > QUOTE_LIMIT ? text.slice(0, QUOTE_LIMIT) : text}"`
}

function sourceHits(source: TextSource): LineHit[] {
  return source.lines.flatMap((l) => {
    const [first] = findTradeoffHits(l.text)
    return first ? [{ path: source.path, where: source.where, line: l.line, hit: first }] : []
  })
}

function countLineHits(source: TextSource): LineHit[] {
  return source.lines.flatMap((l) =>
    findTradeoffHits(l.text)
      .filter((hit) => hit.findings !== undefined)
      .map((hit) => ({ path: source.path, where: source.where, line: l.line, hit }))
  )
}

function noEntryNeededViolations(storyKey: string, source: TextSource): TradeoffViolation[] {
  if (sourceHits(source).length === 0) return []
  return source.lines
    .filter((l) => NO_ENTRY_NEEDED.test(l.text))
    .map((l) => ({
      kind: 'no-entry-needed' as const,
      path: source.path,
      line: l.line,
      message:
        `${storyKey}: says "no deferred-work.md entry needed" while recording unfixed findings ` +
        '(pick-story C2)',
    }))
}

function untrackedViolations(
  storyKey: string,
  hits: LineHit[],
  notes: string[]
): TradeoffViolation[] {
  const suffix = notes.map((n) => `; ${n}`).join('')
  return hits.map((h) => ({
    kind: 'untracked' as const,
    path: h.path,
    line: h.line,
    message: `${storyKey}: ${quote(h.hit.text)} in ${h.where}${suffix}`,
  }))
}

function underItemizedViolations(
  storyKey: string,
  sources: TextSource[],
  entries: DwEntry[]
): TradeoffViolation[] {
  const itemized = entries.reduce((sum, e) => sum + itemizedCount(e), 0)
  const ids = entries.map((e) => e.id).join(', ')
  const verb = entries.length > 1 ? 'itemize' : 'itemizes'
  return sources
    .flatMap(countLineHits)
    .filter((h) => (h.hit.findings ?? 0) > itemized)
    .map((h) => ({
      kind: 'under-itemized' as const,
      path: h.path,
      line: h.line,
      message: `${storyKey}: ${quote(h.hit.text)} (${h.hit.findings} findings) but ${ids} ${verb} ${itemized}`,
    }))
}

/** All violations for one story's text sources; `undefined` when it has no trade-off language. */
function storyViolations(
  storyKey: string,
  sources: TextSource[],
  ledger: Ledger
): TradeoffViolation[] | undefined {
  const hits = sources.flatMap(sourceHits)
  if (hits.length === 0) return undefined
  const contradictions = sources.flatMap((s) => noEntryNeededViolations(storyKey, s))
  const tracking = trackingEntries(storyKey, sources, ledger)
  if (tracking.entries.length === 0) {
    return [...untrackedViolations(storyKey, hits, tracking.notes), ...contradictions]
  }
  return [...underItemizedViolations(storyKey, sources, tracking.entries), ...contradictions]
}

function storySources(root: string, storyKey: string, comment: BodyLine): TextSource[] {
  const sources: TextSource[] = []
  const storyFile = resolveStoryFile(root, storyKey)
  if (storyFile) {
    const path = toRepoPath(root, storyFile.path)
    for (const section of extractReviewSections(storyFile.content)) {
      sources.push({ path, where: `"${section.heading}"`, lines: section.lines })
    }
  }
  sources.push({ path: SPRINT_STATUS_PATH, where: 'its sprint-status comment', lines: [comment] })
  return sources
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Scans the overlay under `rootDir` (the CLI reports unreadable inputs before calling this). */
export function scanReviewTradeoffLedger(rootDir = process.cwd()): TradeoffFindings {
  const root = resolve(rootDir)
  const ledger = loadLedger(readOrEmpty(resolve(root, DEFERRED_WORK_PATH)))
  const statusEntries = parseDevelopmentStatusComments(
    readOrEmpty(resolve(root, SPRINT_STATUS_PATH))
  )
  const findings: TradeoffFindings = { doneCount: 0, hitCount: 0, violations: [] }
  for (const entry of statusEntries) {
    if (entry.value !== 'done' || !STORY_KEY_PATTERN.test(entry.key)) continue
    findings.doneCount++
    const comment = { line: entry.line, text: entry.comment }
    const violations = storyViolations(entry.key, storySources(root, entry.key, comment), ledger)
    if (violations === undefined) continue
    findings.hitCount++
    findings.violations.push(...violations)
  }
  findings.violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return findings
}

const BLOCKS: { kind: TradeoffViolationKind; header: string; fix: string }[] = [
  {
    kind: 'untracked',
    header:
      'FATAL: done stories record review findings as unfixed/accepted trade-offs with no ' +
      'deferred-work.md entry tracking them (epic-43 retro Finding 1):',
    fix:
      'Fix: add one deferred-work.md entry per story (allocate with `pnpm -s next-dw-id --fetch`), ' +
      'with `source_spec: `<story-key>.md``, the findings itemized as (1), (2), ..., and ' +
      '`status: open — Trigger to revisit: <named file/module change or named story/epic>`. ' +
      'Then run `pnpm check-deferred-work-ids`.',
  },
  {
    kind: 'under-itemized',
    header:
      'FATAL: a review records a finding count that its tracking deferred-work.md entries do not ' +
      'itemize (epic-43 retro Finding 1, 43-5 "8 low + 1 medium"):',
    fix:
      'Fix: itemize every finding in the tracking entry as (1), (2), ... (N) on its `reason:` line. ' +
      'When the original review never listed them, recover them with a focused review pass, or ' +
      'write `(k) [lost: not itemized in the original review]` for each missing one.',
  },
  {
    kind: 'no-entry-needed',
    header:
      'FATAL: review text says no deferred-work.md entry is needed while recording unfixed ' +
      'findings (pick-story C2, DW-271):',
    fix: 'Fix: reword the sentence to `ledgered as DW-<n>`, naming the tracking entry.',
  },
]

function report(findings: TradeoffFindings): void {
  if (findings.violations.length === 0) {
    process.stdout.write(
      `${CHECK_NAME}: ${findings.doneCount} done stories scanned, ${findings.hitCount} with ` +
        'trade-off language, all tracked — OK\n'
    )
    return
  }
  const blocks = BLOCKS.flatMap((block) => {
    const violations = findings.violations.filter((v) => v.kind === block.kind)
    if (violations.length === 0) return []
    const lines = violations.map((v) => `  - ${v.path}:${v.line}: ${v.message}`)
    return [[block.header, ...lines, '', block.fix].join('\n')]
  })
  process.stderr.write(`${blocks.join('\n\n')}\n`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.cwd()
  runOverlayGuard(CHECK_NAME, root, SPRINT_STATUS_PATH, () => {
    runOverlayGuard(CHECK_NAME, root, DEFERRED_WORK_PATH, () => {
      report(scanReviewTradeoffLedger(root))
    })
  })
}
