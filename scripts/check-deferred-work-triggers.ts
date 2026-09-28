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
 * Pure, DB-free: a static scan of the private overlay's deferred-work.md using the shared parser in
 * `lib/deferred-work-ledger.ts`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type DwEntry, parseDwEntries } from './lib/deferred-work-ledger.js'
import { formatLineRefs, runOverlayGuard } from './lib/scan-utils.js'

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
const VAGUE_EXACT = ['if it becomes a problem', 'if it recurs']

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
}

/** First word of a status value: markup stripped, trailing `.,:;—-` dropped, lowercased. */
function statusWord(token: string): string {
  return token
    .replaceAll(/[*`]/g, '')
    .replace(/[.,:;—-]+$/, '')
    .toLowerCase()
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
    VAGUE_EXACT.includes(normalized) ||
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

function openEntryViolations(
  entry: DwEntry,
  state: { line: number; token: string }
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
  return violations
}

function entryViolations(entry: DwEntry, state: EntryState): TriggerViolation[] {
  switch (state.kind) {
    case 'closed':
      return []
    case 'open':
      return openEntryViolations(entry, state)
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

function analyze(content: string): TriggerFindings {
  const entries = parseDwEntries(content)
  let openCount = 0
  const violations: TriggerViolation[] = []
  for (const entry of entries) {
    const state = entryState(entry)
    if (state.kind === 'open') openCount++
    violations.push(...entryViolations(entry, state))
  }
  violations.sort((a, b) => a.line - b.line)
  return { entryCount: entries.length, openCount, violations }
}

/** AC-5: every violation in a ledger's content, sorted by line. */
export function findTriggerViolations(content: string): TriggerViolation[] {
  return analyze(content).violations
}

/** Scans `deferred-work.md` under `rootDir` (the CLI reports an unreadable ledger before calling
 * this; here it yields no findings). */
export function scanDeferredWorkTriggers(rootDir = process.cwd()): TriggerFindings {
  let content: string
  try {
    content = readFileSync(resolve(rootDir, DEFERRED_WORK_PATH), 'utf-8')
  } catch {
    return { entryCount: 0, openCount: 0, violations: [] }
  }
  return analyze(content)
}

function report(findings: TriggerFindings): void {
  if (findings.violations.length === 0) {
    process.stdout.write(
      `check-deferred-work-triggers: ${findings.entryCount} DW entries, ${findings.openCount} ` +
        'open, all name a revisit trigger — OK\n'
    )
    return
  }
  process.stderr.write(
    'FATAL: open deferred-work.md entries must name a concrete revisit trigger ' +
      '(epic-59 retro Finding 4, epic-43 retro Finding 13):\n'
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
