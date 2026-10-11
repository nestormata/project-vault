#!/usr/bin/env tsx
/**
 * Story 43.11 AC-5 — allocate the next deferred-work ID across every known branch.
 *
 * "Highest `### DW-` heading in my working tree + 1" collided three times on 2026-09-27 alone:
 * concurrent sessions each saw only their own branch. This helper reads the ledger at every
 * `refs/heads/*` and `refs/remotes/*` ref of the git repo that actually holds it (the private
 * overlay repo, followed through the overlay symlink), plus the working tree, and prints the
 * next free plain numeric ID. It narrows the race window; it cannot close it alone. The
 * `check-deferred-work-ids` guard on every push is the backstop.
 *
 * Usage: `pnpm -s next-dw-id [--fetch] [--reserve [--count N] [--story <key>]]` (do not pipe it: a
 * pipe masks the exit code). Line 1 of stdout is the ID, then the "max seen" line; warnings go to
 * stderr. Read-only apart from `--fetch`.
 *
 * Story 66-19: with `--reserve` the ID(s) are also appended to the working-tree ledger as
 * `### DW-<n>: RESERVED <story> <ISO time>` stubs, under one lock, so the next call (from any
 * session sharing the private tree) cannot allocate the same number. Replace the stub with the real
 * entry (`replaceReservation`), never add a second heading; commit the stub hunk right away.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFERRED_WORK_PATH } from './check-deferred-work-ids.js'
import { parseDwHeadings } from './lib/deferred-work-ledger.js'
import {
  formatReservationStub,
  isValidStoryKey,
  ledgerLockPath,
  RESERVED_SECTION,
} from './lib/dw-reservation.js'
import { appendToFile, withFileLock } from './lib/safe-edit.js'
import { trustedGit } from './lib/trusted-executable.js'

export type NextDwIdResult = {
  /** e.g. `DW-343`. */
  next: string
  /** The highest plain numeric ID seen anywhere (0 when none). */
  max: number
  /** Where `max` was first seen: `working tree` or a full refname; undefined when max is 0. */
  source: string | undefined
  warnings: string[]
}

type LedgerSource = { label: string; content: string }

/** The highest plain numeric ID (`DW-<n>`, normalized) in `content`; variant IDs never count. */
function maxPlainId(content: string): number {
  let max = 0
  for (const { normalizedId } of parseDwHeadings(content)) {
    const plain = /^dw-(\d+)$/.exec(normalizedId)
    if (plain) max = Math.max(max, Number(plain[1]))
  }
  return max
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}

/** git's own stderr message for a failed `trustedGit` call (the thrown error's first line is only
 * "Command failed: ..."), falling back to that first line. */
function gitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  return text === '' ? firstLine(error) : (text.split('\n')[0] ?? text)
}

/** `git show <ref>:<path>`'s error when the ref simply has no such file (the normal skip). */
const PATH_NOT_IN_REF = /does not exist in '|exists on disk, but not in '/

/** Every branch and remote-tracking ref, minus symbolic refs such as `refs/remotes/origin/HEAD`. */
function listRefs(repo: string): string[] {
  return trustedGit(repo, [
    'for-each-ref',
    '--format=%(refname) %(symref)',
    'refs/heads',
    'refs/remotes',
  ])
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([refname, symref]) => refname && !symref)
    .map(([refname]) => refname as string)
}

/** The ledger's content at each ref that has it. A ref without the file is skipped silently; any
 * other read failure is a warning, because silently dropping a ref that holds a higher ID is how
 * the allocator hands out a duplicate. */
function readAtRefs(repo: string, repoRelativePath: string, warnings: string[]): LedgerSource[] {
  const sources: LedgerSource[] = []
  for (const ref of listRefs(repo)) {
    try {
      sources.push({
        label: ref,
        content: trustedGit(repo, ['show', `${ref}:${repoRelativePath}`]),
      })
    } catch (error) {
      const reason = gitErrorText(error)
      if (PATH_NOT_IN_REF.test(reason)) continue // this ref predates the ledger
      warnings.push(
        `could not read ${repoRelativePath} at ${ref} (${reason}); the next ID may collide ` +
          'with an entry on that ref'
      )
    }
  }
  return sources
}

function gitTopLevel(dir: string): string | undefined {
  try {
    return realpathSync(trustedGit(dir, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return undefined
  }
}

export function allocateNextDwId(
  rootDir = process.cwd(),
  options: { fetch?: boolean } = {}
): NextDwIdResult {
  const ledgerLink = resolve(rootDir, DEFERRED_WORK_PATH)
  if (!existsSync(ledgerLink)) {
    throw new Error(
      `${DEFERRED_WORK_PATH} not found (private overlay not attached?); no DW ID allocated`
    )
  }
  const ledger = realpathSync(ledgerLink)
  const warnings: string[] = []
  const sources: LedgerSource[] = [
    { label: 'working tree', content: readFileSync(ledger, 'utf-8') },
  ]

  const repo = gitTopLevel(dirname(ledger))
  if (repo === undefined) {
    warnings.push('not a git repository; using the working-tree file only')
  } else {
    if (options.fetch) {
      try {
        trustedGit(repo, ['fetch', '--all', '--prune'])
      } catch (error) {
        warnings.push(`git fetch --all --prune failed (${firstLine(error)}); using local refs only`)
      }
    }
    sources.push(...readAtRefs(repo, relative(repo, ledger).split(sep).join('/'), warnings))
  }

  let max = 0
  let source: string | undefined
  for (const { label, content } of sources) {
    const sourceMax = maxPlainId(content)
    if (sourceMax > max) {
      max = sourceMax
      source = label
    }
  }
  return { next: `DW-${max + 1}`, max, source, warnings }
}

export type ReserveOptions = {
  fetch?: boolean
  /** Story key written into the stub heading (validated). */
  story?: string
  /** How many consecutive IDs to reserve (1..100, default 1). */
  count?: number
  now?: Date
}

export type ReserveResult = NextDwIdResult & { ids: string[] }

const DEFAULT_STORY = 'unspecified'
const MAX_RESERVE_COUNT = 100

function validateReserveOptions(options: ReserveOptions): { story: string; count: number } {
  const story = options.story ?? DEFAULT_STORY
  if (options.story !== undefined && !isValidStoryKey(story)) {
    throw new Error(`invalid --story key ${JSON.stringify(story)} (expected e.g. 66-19)`)
  }
  const count = options.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > MAX_RESERVE_COUNT) {
    throw new Error(
      `invalid --count ${String(count)} (expected an integer 1..${MAX_RESERVE_COUNT})`
    )
  }
  return { story, count }
}

/** Whether the ledger's last `## ` heading is already the Reserved section (fence-unaware is fine:
 * the section line is only ever written by this function). */
function endsInReservedSection(content: string): boolean {
  const lastH2 = content.split('\n').findLast((line) => /^## /.test(line))
  return lastH2?.trim() === RESERVED_SECTION
}

/**
 * Allocates `count` consecutive IDs and appends their stubs, as one critical section under
 * `deferred-work.md.lock` (next to the ledger's real file). Fails closed, writing nothing, when the
 * ledger is missing or empty, or the story key / count is invalid.
 */
export function reserveDwIds(rootDir = process.cwd(), options: ReserveOptions = {}): ReserveResult {
  const { story, count } = validateReserveOptions(options)
  const ledgerLink = resolve(rootDir, DEFERRED_WORK_PATH)
  if (!existsSync(ledgerLink)) {
    throw new Error(
      `${DEFERRED_WORK_PATH} not found (private overlay not attached?); no DW ID allocated`
    )
  }
  // `git fetch` can outlast the 30 s stale-lock window; holding the lock across it would let another
  // process take a live lock over. Fetch first, then allocate + append under the lock without it.
  const fetchWarnings = options.fetch ? allocateNextDwId(rootDir, { fetch: true }).warnings : []
  return withFileLock(ledgerLockPath(ledgerLink), () => {
    const current = readFileSync(ledgerLink, 'utf-8')
    if (current.trim() === '') {
      throw new Error(
        `${DEFERRED_WORK_PATH} is empty; refusing to reserve (a truncating write most likely ` +
          'wiped it; restore it with `git show HEAD:<path>`)'
      )
    }
    const allocation = allocateNextDwId(rootDir, { fetch: false })
    const first = allocation.max + 1
    const now = options.now ?? new Date()
    const stubs = Array.from({ length: count }, (_, i) =>
      formatReservationStub(first + i, story, now)
    ).join('\n')
    const separator = current.endsWith('\n') ? '\n' : '\n\n'
    const section = endsInReservedSection(current) ? '' : `${RESERVED_SECTION}\n\n`
    appendToFile(ledgerLink, `${separator}${section}${stubs}`)
    return {
      ...allocation,
      warnings: [
        ...fetchWarnings,
        ...allocation.warnings.filter((w) => !fetchWarnings.includes(w)),
      ],
      ids: Array.from({ length: count }, (_, i) => `DW-${first + i}`),
    }
  })
}

type CliArgs = { fetch: boolean; reserve: boolean; story?: string; count?: number }

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

function parseCliArgs(argv: string[]): CliArgs {
  const rawCount = flagValue(argv, '--count')
  return {
    fetch: argv.includes('--fetch'),
    reserve: argv.includes('--reserve'),
    story: flagValue(argv, '--story'),
    count: rawCount === undefined ? undefined : Number(rawCount),
  }
}

function maxLine(result: NextDwIdResult): string {
  return result.source === undefined
    ? 'no plain DW-<n> heading found; starting at DW-1'
    : `max DW-${result.max} seen on ${result.source}`
}

function runCli(): void {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.reserve) {
    const result = reserveDwIds(process.cwd(), args)
    for (const warning of result.warnings) process.stderr.write(`WARN: next-dw-id: ${warning}\n`)
    process.stdout.write(`${result.ids.join('\n')}\n${maxLine(result)}\n`)
    process.stderr.write(
      'next-dw-id: commit the stub hunk now (own hunk only); until it is committed another ' +
        'checkout cannot see the reservation. Replace the stub with the real entry, do not add ' +
        'a second heading.\n'
    )
    return
  }
  if (args.story !== undefined || args.count !== undefined) {
    throw new Error('--story and --count only apply together with --reserve')
  }
  const result = allocateNextDwId(process.cwd(), { fetch: args.fetch })
  for (const warning of result.warnings) process.stderr.write(`WARN: next-dw-id: ${warning}\n`)
  process.stdout.write(
    `${result.next}\n${maxLine(result)}\n` +
      'hint: add --reserve to claim this ID in the ledger now (66-19)\n'
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`FATAL: next-dw-id: ${firstLine(error)}\n`)
    process.exitCode = 1
  }
}
