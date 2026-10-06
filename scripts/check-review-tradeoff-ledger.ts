#!/usr/bin/env tsx
/**
 * Story 43.12 (epic-43 retro Finding 1 [Critical] [REPEAT 4x]) — `done` stories kept recording
 * review findings as "documented as accepted tradeoffs" / "left unfixed" in prose only (43-1,
 * 43-3, 43-4, 43-5, and 30 historical stories), so nobody ever revisited them. pick-story C2 says
 * every unfixed finding gets a `deferred-work.md` entry; this is the CI half of that rule.
 *
 * For every `done` story key (`^\d+-\d+[a-z]?-`), the review text is the union of the story
 * file's review sections (level 2-4 headings with the standalone word "review", minus
 * elicitation / pre-mortem / red team), its Completion Notes section, and its sprint-status.yaml
 * inline comment. FATAL:
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
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDevelopmentStatusComments, SPRINT_STATUS_PATH } from './check-story-status-sync.js'
import {
  type DwEntry,
  extractDwCitations,
  normalizeDwId,
  parseDwEntries,
} from './lib/deferred-work-ledger.js'
import { isTrackedInDeferredWork } from './lib/followup-review-gate.js'
import { readOverlayFile, runOverlayGuard, toRepoPath } from './lib/scan-utils.js'
import {
  type BodyLine,
  dispositionHits,
  extractRiskScopeSections,
  extractSections,
  findCheckedDefers,
  type Heading,
  isNegated,
} from './lib/section-ledger-rules.js'
import { resolveStoryFile } from './lib/story-files.js'
import { citedStoryKeys } from './lib/story-keys.js'

export { isNegated }

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
// `<number> <severity>`, then any `+ / and / , [<number>] <severity>` continuations (AC-3). The
// start is matched in two steps: a word-bounded number (COUNT_NUMBER), then COUNT_JOIN_SEVERITY
// right after it.
const COUNT_NUMBER = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+/gi
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

export type ReviewSection = { heading: string; lines: BodyLine[] }

export type TradeoffViolationKind =
  'untracked' | 'under-itemized' | 'no-entry-needed' | 'unledgered-section' | 'unledgered-defer'

export type TradeoffViolation = {
  kind: TradeoffViolationKind
  path: string
  line: number
  message: string
}

export type TradeoffFindings = {
  doneCount: number
  hitCount: number
  /** Done stories with a disposition line in a Residual risks / Scope Boundaries section (60.8). */
  sectionCount: number
  /** Done stories with a checked `[Review][Defer]` bullet (60.8). */
  deferCount: number
  violations: TradeoffViolation[]
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

type CountStart = { index: number; end: number; value: number }

/** Every `<number> <severity>` in `sentence`, left to right, non-overlapping. */
function countStarts(sentence: string): CountStart[] {
  const starts: CountStart[] = []
  const numbers = new RegExp(COUNT_NUMBER)
  for (let number = numbers.exec(sentence); number; number = numbers.exec(sentence)) {
    const afterNumber = number.index + number[0].length
    const severity = COUNT_JOIN_SEVERITY.exec(sentence.slice(afterNumber))
    if (!severity) continue
    const end = afterNumber + severity[0].length
    starts.push({ index: number.index, end, value: numberValue(number[1] as string) })
    numbers.lastIndex = end
  }
  return starts
}

/** The count phrase starting at `start` (e.g. `8 low + 1 medium`): its end offset and sum. */
function extendCount(sentence: string, start: CountStart): { end: number; sum: number } {
  let end = start.end
  let sum = start.value
  for (;;) {
    const next = countContinuation(sentence.slice(end))
    if (!next) return { end, sum }
    sum += next.value
    end += next.length
  }
}

function countHits(sentence: string): TradeoffHit[] {
  const hits: TradeoffHit[] = []
  for (const start of countStarts(sentence)) {
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
  for (const hit of hits.toSorted((a, b) => a.index - b.index || b.text.length - a.text.length)) {
    if (hit.index < end) continue
    kept.push(hit)
    end = hit.index + hit.text.length
  }
  return kept
}

/**
 * "review" as a standalone word: not joined to a letter, digit, `_` or `-` on either side, so
 * "Preview", "Reviewed", "reviewer", `followup_review_recommended`, `check-story-review-deferrals`
 * and "post-review" are not review headings (code review, 43-12: a bare /review/i matched them).
 */
const REVIEW_WORD = /(?<![\p{L}\p{N}_-])review(?![\p{L}\p{N}_-])/iu

function isScannedTitle(heading: Heading): boolean {
  if (/completion notes/i.test(heading.title)) return true
  return REVIEW_WORD.test(heading.title) && !/elicitation|pre-?mortem|red team/i.test(heading.title)
}

/** AC-1.2 (a)/(a2): the story file's review and Completion Notes sections, fenced lines left out. */
export function extractReviewSections(content: string): ReviewSection[] {
  return extractSections(content, isScannedTitle).map(({ heading, lines }) => ({ heading, lines }))
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

type CitationContext = { ledger: Ledger; sprintKeys: Set<string> }

/**
 * AC-3: `undefined` when the block cites a DW entry that exists and names the story (or, with
 * `allowStoryKey`, another registered story key); otherwise the notes on citations that did not
 * count (empty when there is no citation at all).
 */
function citationNotes(
  storyKey: string,
  text: string,
  context: CitationContext,
  allowStoryKey: boolean
): string[] | undefined {
  const notes: string[] = []
  for (const id of new Set(extractDwCitations(text))) {
    const entry = context.ledger.byId.get(normalizeDwId(id))
    if (!entry) notes.push(`cites ${id}, which is not in deferred-work.md`)
    else if (entryNamesStory(storyKey, context.ledger.entryText.get(entry) ?? '')) return undefined
    else notes.push(`cites ${id}, which does not name this story`)
  }
  if (!allowStoryKey) return notes
  for (const cited of new Set(citedStoryKeys(text))) {
    if (cited === storyKey) notes.push(`cites ${cited}, which is the story itself`)
    else if (context.sprintKeys.has(cited)) return undefined
    else notes.push(`cites ${cited}, which is not in sprint-status.yaml`)
  }
  return notes
}

const suffixOf = (notes: string[]) => notes.map((n) => `; ${n}`).join('')

type RuleScan = { violations: TradeoffViolation[]; sectionHits: number; deferHits: number }

function sectionViolations(
  storyKey: string,
  path: string,
  content: string,
  context: CitationContext
): { violations: TradeoffViolation[]; hits: number } {
  const hits = extractRiskScopeSections(content).flatMap(dispositionHits)
  const violations = hits.flatMap((hit) => {
    const notes = citationNotes(storyKey, hit.text, context, true)
    if (notes === undefined) return []
    const first = hit.text.split('\n')[0] ?? ''
    return [
      {
        kind: 'unledgered-section' as const,
        path,
        line: hit.line,
        message:
          `${storyKey}: ${quote(first.trim())} in "${hit.heading}" records an accepted risk / ` +
          `scope boundary with no ledger entry or backlog story${suffixOf(notes)}`,
      },
    ]
  })
  return { violations, hits: hits.length }
}

function deferViolations(
  storyKey: string,
  path: string,
  content: string,
  context: CitationContext
): { violations: TradeoffViolation[]; hits: number } {
  const defers = findCheckedDefers(content)
  const violations = defers.flatMap((defer) => {
    const notes = citationNotes(storyKey, defer.text, context, false)
    if (notes === undefined) return []
    return [
      {
        kind: 'unledgered-defer' as const,
        path,
        line: defer.line,
        message:
          `${storyKey}: checked [Review][Defer] bullet has no ledger entry ` +
          `(cite DW-<id>)${suffixOf(notes)}`,
      },
    ]
  })
  return { violations, hits: defers.length }
}

/** Rules S and D (Story 60.8) for one done story's file. */
function ruleScan(root: string, storyKey: string, context: CitationContext): RuleScan {
  const storyFile = resolveStoryFile(root, storyKey)
  if (!storyFile) return { violations: [], sectionHits: 0, deferHits: 0 }
  const path = toRepoPath(root, storyFile.path)
  const section = sectionViolations(storyKey, path, storyFile.content, context)
  const defer = deferViolations(storyKey, path, storyFile.content, context)
  return {
    violations: [...section.violations, ...defer.violations],
    sectionHits: section.hits,
    deferHits: defer.hits,
  }
}

/** One violation per path+line: the earliest kind in `BLOCKS` order wins. */
function dedupeViolations(violations: TradeoffViolation[]): TradeoffViolation[] {
  const order = BLOCKS.map((b) => b.kind)
  const best = new Map<string, TradeoffViolation>()
  for (const v of violations) {
    const key = `${v.path}:${v.line}`
    const known = best.get(key)
    if (!known || order.indexOf(v.kind) < order.indexOf(known.kind)) best.set(key, v)
  }
  return [...best.values()]
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

/** Scans the overlay under `rootDir` (the CLI reports unreadable inputs before calling this). */
export function scanReviewTradeoffLedger(rootDir = process.cwd()): TradeoffFindings {
  const root = resolve(rootDir)
  const ledger = loadLedger(readOverlayFile(root, DEFERRED_WORK_PATH) ?? '')
  const statusEntries = parseDevelopmentStatusComments(
    readOverlayFile(root, SPRINT_STATUS_PATH) ?? ''
  )
  const context = { ledger, sprintKeys: new Set(statusEntries.map((entry) => entry.key)) }
  const findings: TradeoffFindings = {
    doneCount: 0,
    hitCount: 0,
    sectionCount: 0,
    deferCount: 0,
    violations: [],
  }
  for (const entry of statusEntries) {
    if (entry.value !== 'done' || !STORY_KEY_PATTERN.test(entry.key)) continue
    findings.doneCount++
    const comment = { line: entry.line, text: entry.comment }
    const violations = storyViolations(entry.key, storySources(root, entry.key, comment), ledger)
    if (violations !== undefined) {
      findings.hitCount++
      findings.violations.push(...violations)
    }
    const rules = ruleScan(root, entry.key, context)
    if (rules.sectionHits > 0) findings.sectionCount++
    if (rules.deferHits > 0) findings.deferCount++
    findings.violations.push(...rules.violations)
  }
  findings.violations = dedupeViolations(findings.violations)
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
  {
    kind: 'unledgered-section',
    header:
      'FATAL: done stories record accepted residual risks / scope boundaries / known limits with ' +
      'no deferred-work.md entry or backlog story (epic-60 retro Finding 4):',
    fix:
      'Fix: cite the tracking entry on the line (`ledgered as DW-<n>`, allocate with ' +
      '`pnpm -s next-dw-id --fetch`, `source_spec: `<story-key>.md``, `status: open — Trigger to ' +
      'revisit: ...`) or a registered backlog story key.',
  },
  {
    kind: 'unledgered-defer',
    header:
      'FATAL: done stories carry checked [Review][Defer] bullets with no deferred-work.md entry ' +
      '(epic-61 retro Finding 1):',
    fix:
      'Fix: cite the tracking entry on the bullet (`ledgered as DW-<n>`, allocate with ' +
      '`pnpm -s next-dw-id --fetch`, `source_spec: `<story-key>.md``, `status: open — Trigger to ' +
      'revisit: ...`). A ticked box means "decided to defer", not "ledgered".',
  },
]

function report(findings: TradeoffFindings): void {
  if (findings.violations.length === 0) {
    process.stdout.write(
      `${CHECK_NAME}: ${findings.doneCount} done stories scanned, ${findings.hitCount} with ` +
        `trade-off language, ${findings.sectionCount} with section dispositions, ` +
        `${findings.deferCount} with checked defers, all tracked — OK\n`
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
