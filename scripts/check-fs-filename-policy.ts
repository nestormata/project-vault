#!/usr/bin/env tsx
/**
 * Story 43.26 AC-7 - keeps the `security/detect-non-literal-fs-filename` policy from eroding.
 *
 * Nestor's decision of 2026-10-04 (reorg Q16d/Q16e, DW-444 / DW-511): the rule is off for test
 * files, off for a pinned list of `fs-access.ts` modules that state a reason per function, and
 * never silenced inline. This guard fails (exit 1, one `path:line` per finding) when:
 *   1. any tracked file carries an eslint disable directive naming the rule (any form: line,
 *      next-line, block, file-level; a directive may wrap onto the next two lines);
 *   2. a tracked `fs-access.ts` / `fs-access.mjs` is not in the pinned list
 *      (`FS_ACCESS_MODULES` in `packages/eslint-config/index.js`), or a pinned module is missing;
 *   3. an exported function or constant of a pinned module has no JSDoc block with a `Reason:` line;
 *   4. a shipped-guard module (`apps/web/guards/fs-access.ts`) imports anything but `node:` modules.
 *
 * Skipped for check 1: this guard and its test (they name the rule), the private overlay and
 * tooling (`_bmad-output/**`, `.claude/**`).
 */
import { pathToFileURL } from 'node:url'
import { FS_ACCESS_MODULES } from '../packages/eslint-config/index.js'
import { gitGrep, reportFindings } from './lib/git-grep.js'
import { trustedGit } from './lib/trusted-executable.js'

export type PolicyFinding = { location: string; reason: string }

// Built by concatenation so this file never contains the name it hunts for inside a directive.
const RULE = 'detect-non-literal-' + 'fs-filename'
const SELF_PATHS = [
  'scripts/check-fs-filename-policy.ts',
  'scripts/check-fs-filename-policy.test.ts',
]
const NEVER_SCANNED = ['_bmad-output/**', '.claude/**']
const SHIPPED_GUARD_MODULES = ['apps/web/guards/fs-access.ts']
const FS_ACCESS_NAME = /(^|\/)fs-access\.(ts|mjs)$/

const git = trustedGit

function trackedText(repoRoot: string, path: string): string | null {
  const text = gitGrep(repoRoot, ['-h', '-e', '^', '--', `:(literal)${path}`])
  return text === '' ? null : text
}

function trackedFsAccessFiles(repoRoot: string): string[] {
  return git(repoRoot, ['ls-files'])
    .split('\n')
    .filter((path) => FS_ACCESS_NAME.test(path))
}

type GrepRow = { path: string; line: string; text: string; isMatch: boolean }

const MATCH_ROW = /^([^:]+):(\d+):(.*)$/
const CONTEXT_ROW = /^([^:]+?)-(\d+)-(.*)$/

/** `git grep -n` rows: `path:line:text` for a match, `path-line-text` for -A context. */
function parseGrepRow(row: string): GrepRow | null {
  const match = MATCH_ROW.exec(row)
  if (match)
    return { path: match[1] ?? '', line: match[2] ?? '', text: match[3] ?? '', isMatch: true }
  const context = CONTEXT_ROW.exec(row)
  if (context)
    return {
      path: context[1] ?? '',
      line: context[2] ?? '',
      text: context[3] ?? '',
      isMatch: false,
    }
  return null
}

const DIRECTIVE_CONTEXT_LINES = 2

/** Check 1: grep context (-A2) so a directive wrapped over a few lines is still seen. */
function findInlineDirectives(repoRoot: string): PolicyFinding[] {
  const excludes = [...SELF_PATHS, ...NEVER_SCANNED].map((p) => `:(exclude,glob)${p}`)
  const out = gitGrep(repoRoot, ['-n', '-A2', '-E', '-e', 'eslint-disable', '--', '.', ...excludes])
  const findings: PolicyFinding[] = []
  let directive: GrepRow | null = null
  let seen = 0
  for (const row of out.split('\n').map(parseGrepRow)) {
    if (row === null) {
      directive = null
      continue
    }
    if (row.isMatch) {
      directive = row
      seen = 0
    } else if (directive?.path !== row.path || ++seen > DIRECTIVE_CONTEXT_LINES) {
      directive = null
    }
    if (directive && row.text.includes(RULE)) {
      findings.push({
        location: `${directive.path}:${directive.line}`,
        reason: `inline eslint disable of ${RULE}`,
      })
      directive = null
    }
  }
  return findings
}

function findPinProblems(repoRoot: string, pinned: readonly string[]): PolicyFinding[] {
  const tracked = trackedFsAccessFiles(repoRoot)
  return [
    ...tracked
      .filter((path) => !pinned.includes(path))
      .map((path) => ({
        location: path,
        reason:
          'fs-access module is not in FS_ACCESS_MODULES (the lint exemption is a pinned list)',
      })),
    ...pinned
      .filter((path) => !tracked.includes(path))
      .map((path) => ({ location: path, reason: 'pinned fs-access module does not exist' })),
  ]
}

const EXPORT_DECL = /^export (?:async )?(?:function|const) (\w+)/

/** The JSDoc block ending on the line above `index`, or null when that line does not close a comment. */
function docBlockAbove(lines: string[], index: number): string[] | null {
  if (lines.at(index - 1)?.trim() !== '*/') return null
  const block: string[] = []
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const line = lines.at(cursor) ?? ''
    block.push(line)
    if (line.trim().startsWith('/**')) return block
  }
  return null
}

/** Check 3: every exported function/const of a pinned module is preceded by a JSDoc with `Reason:`. */
function findMissingReasons(repoRoot: string, path: string): PolicyFinding[] {
  const lines = (trackedText(repoRoot, path) ?? '').split('\n')
  const findings: PolicyFinding[] = []
  lines.forEach((text, index) => {
    const name = EXPORT_DECL.exec(text)?.[1]
    if (!name) return
    const block = docBlockAbove(lines, index)
    if (block?.some((line) => line.includes('Reason:'))) return
    findings.push({
      location: `${path}:${index + 1}`,
      reason: `${name} has no JSDoc with a Reason: line`,
    })
  })
  return findings
}

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

/** Check 4: a shipped-guard module may import only `node:` modules. */
function findNonNodeImports(repoRoot: string, path: string): PolicyFinding[] {
  const lines = (trackedText(repoRoot, path) ?? '').split('\n')
  return lines.flatMap((text, index) =>
    [...text.matchAll(IMPORT_SPECIFIER)]
      .filter((match) => !(match[1] ?? '').startsWith('node:'))
      .map((match) => ({
        location: `${path}:${index + 1}`,
        reason: `shipped guard module imports ${match[1]}; only node: modules are allowed`,
      }))
  )
}

/** Every policy violation under `repoRoot` (a git work tree). Empty means clean. */
export function findFsFilenamePolicyViolations(
  repoRoot: string,
  pinned: readonly string[] = FS_ACCESS_MODULES
): PolicyFinding[] {
  const tracked = trackedFsAccessFiles(repoRoot)
  const present = pinned.filter((path) => tracked.includes(path))
  return [
    ...findInlineDirectives(repoRoot),
    ...findPinProblems(repoRoot, pinned),
    ...present.flatMap((path) => findMissingReasons(repoRoot, path)),
    ...present
      .filter((path) => SHIPPED_GUARD_MODULES.includes(path))
      .flatMap((path) => findNonNodeImports(repoRoot, path)),
  ]
}

function main(): void {
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const findings = findFsFilenamePolicyViolations(repoRoot)
  if (findings.length === 0) {
    process.stdout.write(
      `check-fs-filename-policy: OK - no inline ${RULE} disables, fs-access modules pinned with reasons.\n`
    )
    return
  }
  reportFindings(
    `check-fs-filename-policy: ${findings.length} violation(s). Route file access through a pinned fs-access module with a Reason: line (Nestor's 2026-10-04 decision, DW-444/DW-511); a new exemption needs an expert consult plus Nestor's sign-off (AGENTS.md).`,
    findings
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
