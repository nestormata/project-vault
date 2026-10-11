#!/usr/bin/env tsx
/**
 * Story 43.12 (epic-59 retro Finding 4 [REPEAT 5x], epic-43 retro Finding 13) — open
 * `deferred-work.md` entries kept shipping without a revisit trigger despite pick-story C2/C4
 * requiring one, so nothing ever told anyone when to look at them again. This guard fails the push
 * that adds (or leaves) an open entry without one.
 *
 * Canonical form (also in `deferred-work-format.md` and pick-story C2):
 *
 *   status: open — Trigger to revisit: <the next change to a named file/module, or a named
 *   story/epic, or a named external event>.
 *
 * A space after `open`, never `open.`: bmad-loop decides "open" as `status.split()[0] == "open"`,
 * so `open.` / `open,` entries are invisible to its sweep.
 *
 * FATAL, per entry: an open entry with no `Trigger[s] [to revisit] [(...)]:` label, or with a
 * vague or under-12-character value; an open token followed by punctuation; more than one
 * `status:` line (bmad-loop reads the first, check-cross-repo-dw-closure the last); an unknown
 * status word or no `status:` line (so a typo cannot hide an open entry). Closed entries need no
 * trigger.
 *
 * Story 70.5 (epic-70 retro Finding 3): also FATAL when an open entry's every trigger clause names
 * only `done` stories (see `lib/trigger-liveness.ts`): a trigger that can no longer fire is rot.
 * That rule needs `sprint-status.yaml`; when it is unreadable the rule is skipped with one warning.
 *
 * Pure, DB-free: a static scan of the private overlay's deferred-work.md using the shared parser in
 * `lib/deferred-work-ledger.ts`.
 */
import { pathToFileURL } from 'node:url'
import { parseDevelopmentStatusComments, SPRINT_STATUS_PATH } from './check-story-status-sync.js'
import { type DwEntry, parseDwEntries } from './lib/deferred-work-ledger.js'
import { formatLineRefs, readOverlayFile, runOverlayGuard } from './lib/scan-utils.js'
import { deadTriggerKeys, type StatusByKey } from './lib/trigger-liveness.js'

export const DEFERRED_WORK_PATH = '_bmad-output/implementation-artifacts/deferred-work.md'

const CLOSED_WORDS = new Set([
  'done',
  'closed',
  'resolved',
  'superseded',
  'withdrawn',
  'wontfix',
  'obsolete',
  'duplicate',
])
const OPEN_WORDS = new Set([
  'open',
  'in-progress',
  'partially',
  'partially-resolved',
  'deferred',
  'blocked',
  'pending',
])

const STATUS_LINE = /^status:(.*)$/
// The label `Trigger[s] [to revisit] [(<note>)]:`, matched in flat steps (no nested quantifiers).
const LABEL_WORD = /\btriggers?/gi
const LABEL_TO_REVISIT = /^\s+to\s+revisit/i
const LABEL_NOTE = /^\s*\([^)]*\)/
const LABEL_COLON = /^\s*:/
const MIN_TRIGGER_CHARS = 12

/** A value that is, or starts with, one of these (after lowercasing and dropping punctuation) is
 * vague. */
const VAGUE_PREFIXES = [
  'tbd',
  'n/a',
  'none',
  'unknown',
  'later',
  'someday',
  'eventually',
  'as needed',
  'when needed',
  'when time permits',
  'if needed',
  'tracked as debt',
  'debt only',
  'whenever',
]
/** Vague only when bare: `if it recurs in <named place>` names something and passes. */
const VAGUE_EXACT = new Set(['if it becomes a problem', 'if it recurs'])

export type EntryState =
  | { kind: 'open'; line: number; token: string }
  | { kind: 'closed'; line: number }
  | { kind: 'unknown'; line: number; word: string }
  | { kind: 'missing' }
  | { kind: 'multiple'; lines: number[] }

export type TriggerCheck =
  { kind: 'ok' } | { kind: 'none' } | { kind: 'vague' | 'short'; value: string }

export type TriggerViolation = { line: number; message: string }

export type TriggerFindings = {
  entryCount: number
  openCount: number
  violations: TriggerViolation[]
  /** True when the stale-trigger rule was skipped because sprint-status.yaml was unreadable. */
  staleRuleSkipped: boolean
}

/** Characters dropped from the end of a status word. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '—', '-'])

/** `text` without its trailing run of TRAILING_PUNCTUATION: a single backwards scan, where the
 * equivalent unanchored `/[...]+$/` regex backtracks quadratically on long punctuation runs. */
function dropTrailingPunctuation(text: string): string {
  let end = text.length
  while (end > 0 && TRAILING_PUNCTUATION.has(text.charAt(end - 1))) end -= 1
  return text.slice(0, end)
}

/** First word of a status value: markup stripped, trailing `.,:;—-` dropped, lowercased. */
function statusWord(token: string): string {
  return dropTrailingPunctuation(token.replaceAll(/[*`]/g, '')).toLowerCase()
}

/** AC-5.2: the entry's state from its `status:` line(s). */
export function entryState(entry: DwEntry): EntryState {
  const statusLines = entry.lines.filter((l) => STATUS_LINE.test(l.text))
  if (statusLines.length === 0) return { kind: 'missing' }
  if (statusLines.length > 1) return { kind: 'multiple', lines: statusLines.map((l) => l.line) }

  const status = statusLines[0] as { line: number; text: string }
  const value = (STATUS_LINE.exec(status.text)?.[1] ?? '').trim()
  const token = value.split(/\s+/)[0] ?? ''
  const word = statusWord(token)
  if (OPEN_WORDS.has(word)) return { kind: 'open', line: status.line, token }
  if (CLOSED_WORDS.has(word)) return { kind: 'closed', line: status.line }
  return { kind: 'unknown', line: status.line, word }
}

function normalizeTriggerValue(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}/\s]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function isVague(value: string): boolean {
  const normalized = normalizeTriggerValue(value)
  return (
    VAGUE_EXACT.has(normalized) ||
    VAGUE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))
  )
}

/** Drops `pattern`'s match from the start of `text`, if any. */
function dropPrefix(text: string, pattern: RegExp): string {
  const match = pattern.exec(text)
  return match ? text.slice(match[0].length) : text
}

/** The text after the first `Trigger[s] [to revisit] [(<note>)]:` label in `line`, or undefined. */
function triggerValue(line: string): string | undefined {
  for (const word of line.matchAll(LABEL_WORD)) {
    const afterWord = line.slice(word.index + word[0].length)
    const rest = dropPrefix(dropPrefix(afterWord, LABEL_TO_REVISIT), LABEL_NOTE)
    const colon = LABEL_COLON.exec(rest)
    if (colon) return rest.slice(colon[0].length).trim()
  }
  return undefined
}

/** AC-5.3: whether one body line carries a usable trigger label + value. */
export function checkTriggerLabel(line: string): TriggerCheck {
  const value = triggerValue(line)
  if (value === undefined) return { kind: 'none' }
  if (isVague(value)) return { kind: 'vague', value }
  if (value.replaceAll(/\s/g, '').length < MIN_TRIGGER_CHARS) return { kind: 'short', value }
  return { kind: 'ok' }
}

/** The best trigger check over an entry's body: `ok` if any line passes, else the first labelled
 * failure, else `none`. */
function entryTrigger(entry: DwEntry): TriggerCheck {
  const checks = entry.lines.map((l) => checkTriggerLabel(l.text))
  return (
    checks.find((c) => c.kind === 'ok') ?? checks.find((c) => c.kind !== 'none') ?? { kind: 'none' }
  )
}

function triggerMessage(id: string, check: TriggerCheck): string | undefined {
  switch (check.kind) {
    case 'ok':
      return undefined
    case 'none':
      return `${id} is open but names no revisit trigger`
    case 'vague':
      return `${id} has a vague trigger "${check.value}"`
    case 'short':
      return `${id} has a too-short trigger "${check.value}" (under ${MIN_TRIGGER_CHARS} non-space characters)`
  }
}

/** Every trigger value (text after a `Trigger[s] ...:` label) in the entry's body lines. */
export function entryTriggerValues(entry: DwEntry): string[] {
  return entry.lines.flatMap((l) => triggerValue(l.text) ?? [])
}

function staleViolation(
  entry: DwEntry,
  line: number,
  statuses: StatusByKey | undefined
): TriggerViolation[] {
  if (statuses === undefined) return []
  const dead = deadTriggerKeys(entryTriggerValues(entry), statuses)
  if (dead === undefined) return []
  return [
    {
      line,
      message:
        `${entry.id}: every revisit trigger clause names only finished stories (${dead.join(', ')}) ` +
        'so it can never fire; re-point the trigger at a live event, or close the entry',
    },
  ]
}

function openEntryViolations(
  entry: DwEntry,
  state: { line: number; token: string },
  statuses: StatusByKey | undefined
): TriggerViolation[] {
  const violations: TriggerViolation[] = []
  if (statusWord(state.token) === 'open' && state.token !== 'open') {
    violations.push({
      line: state.line,
      message:
        `${entry.id}: status token "${state.token}" reads as not-open to bmad-loop; ` +
        'write "status: open — ..."',
    })
  }
  const message = triggerMessage(entry.id, entryTrigger(entry))
  if (message) violations.push({ line: state.line, message })
  else violations.push(...staleViolation(entry, state.line, statuses))
  return violations
}

function entryViolations(
  entry: DwEntry,
  state: EntryState,
  statuses: StatusByKey | undefined
): TriggerViolation[] {
  switch (state.kind) {
    case 'closed':
      return []
    case 'open':
      return openEntryViolations(entry, state, statuses)
    case 'missing':
      return [{ line: entry.line, message: `${entry.id}: no status: line` }]
    case 'unknown':
      return [{ line: state.line, message: `${entry.id}: unknown status "${state.word}"` }]
    case 'multiple':
      return [
        {
          line: state.lines[0] as number,
          message: `${entry.id} has ${state.lines.length} status: lines (${formatLineRefs(state.lines)}); keep one`,
        },
      ]
  }
}

function analyze(content: string, statuses?: StatusByKey): TriggerFindings {
  const entries = parseDwEntries(content)
  let openCount = 0
  const violations: TriggerViolation[] = []
  for (const entry of entries) {
    const state = entryState(entry)
    if (state.kind === 'open') openCount++
    violations.push(...entryViolations(entry, state, statuses))
  }
  violations.sort((a, b) => a.line - b.line)
  return { entryCount: entries.length, openCount, violations, staleRuleSkipped: false }
}

/** AC-5: every violation in a ledger's content, sorted by line. `statuses` (story key to
 * `development_status` value) switches on the stale-trigger rule; without it the rule is off. */
export function findTriggerViolations(content: string, statuses?: StatusByKey): TriggerViolation[] {
  return analyze(content, statuses).violations
}

function readStatuses(rootDir: string): StatusByKey | undefined {
  const content = readOverlayFile(rootDir, SPRINT_STATUS_PATH)
  if (content === undefined) return undefined
  return new Map(parseDevelopmentStatusComments(content).map((row) => [row.key, row.value]))
}

/** Scans `deferred-work.md` under `rootDir` (the CLI reports an unreadable ledger before calling
 * this; here it yields no findings). */
export function scanDeferredWorkTriggers(rootDir = process.cwd()): TriggerFindings {
  const content = readOverlayFile(rootDir, DEFERRED_WORK_PATH)
  if (content === undefined) {
    return { entryCount: 0, openCount: 0, violations: [], staleRuleSkipped: false }
  }
  const statuses = readStatuses(rootDir)
  return { ...analyze(content, statuses), staleRuleSkipped: statuses === undefined }
}

function report(findings: TriggerFindings): void {
  if (findings.staleRuleSkipped) {
    process.stderr.write(
      `check-deferred-work-triggers: WARNING — ${SPRINT_STATUS_PATH} is not readable; ` +
        'stale-trigger rule skipped\n'
    )
  }
  if (findings.violations.length === 0) {
    process.stdout.write(
      `check-deferred-work-triggers: ${findings.entryCount} DW entries, ${findings.openCount} ` +
        'open, all name a revisit trigger — OK\n'
    )
    return
  }
  process.stderr.write(
    'FATAL: open deferred-work.md entries must name a concrete revisit trigger that can still ' +
      'fire (epic-59 retro Finding 4, epic-43 retro Finding 13, epic-70 retro Finding 3):\n'
  )
  for (const v of findings.violations) {
    process.stderr.write(`  - ${DEFERRED_WORK_PATH}:${v.line}: ${v.message}\n`)
  }
  process.stderr.write(
    '\nFix: keep exactly one status line per entry, written as ' +
      '`status: open — Trigger to revisit: <the next change to a named file/module, or a named ' +
      'story/epic, or a named external event>.` (a space after `open`, never `open.`, because ' +
      'bmad-loop only sees an exact `open` token). pick-story C2: a trigger is "the next change to ' +
      "a named file or module, or a named later story or epic. 'Tracked as debt' alone is not a " +
      'trigger". Closed entries use done/closed/resolved/superseded/withdrawn/wontfix/obsolete/' +
      'duplicate.\n'
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runOverlayGuard('check-deferred-work-triggers', process.cwd(), DEFERRED_WORK_PATH, () => {
    report(scanDeferredWorkTriggers())
  })
}
