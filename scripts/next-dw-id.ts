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
 * Usage: `pnpm -s next-dw-id [--fetch]` (do not pipe it: a pipe masks the exit code). Line 1 of stdout is the ID, line 2 says
 * where the current max was seen; warnings go to stderr. Read-only apart from `--fetch`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFERRED_WORK_PATH } from './check-deferred-work-ids.js'
import { parseDwHeadings } from './lib/deferred-work-ledger.js'
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = allocateNextDwId(process.cwd(), { fetch: process.argv.includes('--fetch') })
    for (const warning of result.warnings) process.stderr.write(`WARN: next-dw-id: ${warning}\n`)
    const where =
      result.source === undefined
        ? 'no plain DW-<n> heading found; starting at DW-1'
        : `max DW-${result.max} seen on ${result.source}`
    process.stdout.write(`${result.next}\n${where}\n`)
  } catch (error) {
    process.stderr.write(`FATAL: next-dw-id: ${firstLine(error)}\n`)
    process.exitCode = 1
  }
}
