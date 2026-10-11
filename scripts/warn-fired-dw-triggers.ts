#!/usr/bin/env tsx
/**
 * Story 43.22 — WARN (never fail) when the current diff touches a file or directory that an open
 * `deferred-work.md` entry names in its revisit trigger. DW-271's trigger fired during Story 40.1
 * and nobody noticed; Guard B (`check-deferred-work-triggers`) checks that a trigger exists, this
 * checks the useful half: that one just fired.
 *
 *   pnpm warn-fired-dw-triggers [--base <ref>] [--files <path> ...]
 *
 * Advisory by construction: every path, including a missing overlay, an unreadable ledger or a git
 * failure, prints at most one `skipped (<reason>)` line and ends with exit code 0. Output carries
 * only the DW id, the ledger line and the matched paths, never entry bodies (they may hold private
 * detail). Changed files come from `git` invoked with argument arrays, parsed NUL-separated.
 */
import { pathToFileURL } from 'node:url'
import { DEFERRED_WORK_PATH } from './check-deferred-work-triggers.js'
import { parseDwEntries } from './lib/deferred-work-ledger.js'
import { type FiredTrigger, findFiredTriggers, normalizePath } from './lib/dw-trigger-hits.js'
import { readOverlayFile } from './lib/scan-utils.js'
import { trustedGit } from './lib/trusted-executable.js'

const PREFIX = 'warn-fired-dw-triggers:'
const DEFAULT_BASE = 'origin/main'
const FALLBACK_BASE = 'main'
const BASE_PATTERN = /^\w[\w./@^~-]*$/
const MAX_PRINTED_HITS = 25
const MAX_FILES_PER_LINE = 3
const ANNOTATION_TITLE = 'Open DW trigger fired'
const LEDGER_NAME = 'deferred-work.md'

export type RunOptions = {
  rootDir: string
  env: Record<string, string | undefined>
  out: (line: string) => void
}

type ParsedArgs = { base?: string; baseGiven: boolean; files?: string[] }

/** A reason to skip, carried as a value so the caller prints exactly one `skipped` line. */
class Skip extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { baseGiven: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--base') {
      parsed.baseGiven = true
      parsed.base = rest.shift()
    } else if (arg === '--files') {
      const files: string[] = []
      while (rest.length > 0 && !rest[0]?.startsWith('--')) files.push(rest.shift() as string)
      parsed.files = files
    }
  }
  return parsed
}

/** Paths from `git diff --name-status -z`: `<status> NUL <path> NUL` pairs. */
function pathsFromNameStatus(output: string): string[] {
  return output.split('\0').filter((_, index) => index % 2 === 1)
}

/** Paths from `git status --porcelain -z`: `XY <path>` records; a rename or copy is followed by a
 * record holding the original path, which is kept too. */
function pathsFromPorcelain(output: string): string[] {
  const records = output.split('\0')
  const paths: string[] = []
  while (records.length > 0) {
    const record = records.shift() as string
    if (record.length < 4) continue
    paths.push(record.slice(3))
    if (/[RC]/.test(record.slice(0, 2))) paths.push(records.shift() ?? '')
  }
  return paths
}

function diffAgainst(rootDir: string, base: string): string[] {
  const output = trustedGit(rootDir, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    '--diff-filter=ACDMRT',
    `${base}...HEAD`,
  ])
  return pathsFromNameStatus(output)
}

function committedChanges(rootDir: string, args: ParsedArgs): string[] {
  const bases = args.baseGiven ? [args.base] : [DEFAULT_BASE, FALLBACK_BASE]
  let lastError: unknown
  for (const base of bases) {
    try {
      return diffAgainst(rootDir, base as string)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function changedFilesFromGit(rootDir: string, args: ParsedArgs): string[] {
  if (args.baseGiven && !BASE_PATTERN.test(args.base ?? '')) throw new Skip('invalid --base')
  try {
    const committed = committedChanges(rootDir, args)
    const working = pathsFromPorcelain(
      trustedGit(rootDir, ['status', '--porcelain', '-z', '--untracked-files=all'])
    )
    return [...committed, ...working]
  } catch {
    throw new Skip('git could not list the changed files')
  }
}

function changedFiles(rootDir: string, args: ParsedArgs): string[] {
  if (args.files === undefined) return changedFilesFromGit(rootDir, args)
  if (args.files.length === 0) throw new Skip('no files given')
  return args.files
}

/** Workflow-command message escaping: `%`, CR, LF, and `:` / `,` so nothing can add a command. */
export function escapeWorkflowMessage(text: string): string {
  return text
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C')
}

function displayFiles(hit: FiredTrigger): string[] {
  const shown = hit.matchedFiles.slice(0, MAX_FILES_PER_LINE)
  const extra = hit.matchedFiles.length - shown.length
  return extra > 0 ? [...shown, `+${extra} more`] : shown
}

function plainLine(hit: FiredTrigger): string {
  const files = displayFiles(hit)
    .join(', ')
    .replaceAll(/[\r\n]/g, '?')
  return `  ${hit.id} (${LEDGER_NAME}:${hit.line}) -> ${files}`
}

function annotationLine(hit: FiredTrigger): string {
  const message = `${hit.id} names ${displayFiles(hit).join(' ')} (${LEDGER_NAME}:${hit.line})`
  return `::warning title=${ANNOTATION_TITLE}::${escapeWorkflowMessage(message)}`
}

function report(hits: FiredTrigger[], options: RunOptions): void {
  if (hits.length === 0) {
    options.out(`${PREFIX} no open deferred-work trigger names a changed file.`)
    return
  }
  const printed = hits.slice(0, MAX_PRINTED_HITS)
  const github = options.env.GITHUB_ACTIONS === 'true'
  options.out(`WARN: ${hits.length} open deferred-work entries name a file changed in this diff:`)
  for (const hit of printed) {
    options.out(plainLine(hit))
    if (github) options.out(annotationLine(hit))
  }
  if (hits.length > printed.length) options.out(`  ... and ${hits.length - printed.length} more`)
  options.out(
    '  Resolve each entry (fix it, close it with a reason), update it, or re-point its trigger.'
  )
}

function readLedger(rootDir: string) {
  const content = readOverlayFile(rootDir, DEFERRED_WORK_PATH)
  if (content === undefined) throw new Skip(`${LEDGER_NAME} not readable`)
  const entries = parseDwEntries(content)
  if (entries.length === 0) throw new Skip(`no DW entries in ${LEDGER_NAME}`)
  return entries
}

/** The whole check; never throws and never sets a failing exit code. */
export function runWarnFiredDwTriggers(argv: string[], options: RunOptions): void {
  try {
    const args = parseArgs(argv)
    const entries = readLedger(options.rootDir)
    const files = changedFiles(options.rootDir, args).map(normalizePath)
    report(findFiredTriggers(entries, files), options)
  } catch (error) {
    const reason = error instanceof Skip ? error.message : 'unexpected error'
    options.out(`${PREFIX} skipped (${reason})`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runWarnFiredDwTriggers(process.argv.slice(2), {
    rootDir: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
  })
}
