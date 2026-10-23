#!/usr/bin/env tsx
/**
 * Story 43.26 AC-7 - keeps the `security/detect-non-literal-fs-filename` policy from eroding.
 *
 * Nestor's decision of 2026-10-04 (reorg Q16d/Q16e, DW-444 / DW-511): the rule is off for test
 * files, off for a pinned list of `fs-access.ts` modules that state a reason per function, and
 * never silenced inline. This guard fails (exit 1, one `path:line` per finding) when:
 *   1. any tracked file carries an eslint disable directive naming the rule (any form: line,
 *      next-line, block, file-level, or an inline `/* eslint <rule>: off *\/` config comment; a
 *      directive may wrap onto the next two lines), or a disable that names no rule at all;
 *   2. a tracked `fs-access.ts` / `fs-access.mjs` is not in the pinned list
 *      (`FS_ACCESS_MODULES` in `packages/eslint-config/index.js`), or a pinned module is missing;
 *   3. an exported function or constant of a pinned module has no JSDoc block with a non-empty
 *      `Reason:` line, or the module exports a value any other way (re-export, class, default);
 *   4. a shipped-guard module (`apps/web/guards/fs-access.ts`) imports anything but `node:` modules;
 *   5. a tracked eslint config file other than the shared policy names the rule.
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

type GrepRow = { path: string; line: string; text: string }

/**
 * `git grep -z -n` rows are `path NUL line NUL text` for matches and -A context alike, so a path
 * containing `-<digits>-` or text containing `:<digits>:` cannot be misread; `--` group
 * separators (and anything else) parse to null.
 */
function parseGrepRow(row: string): GrepRow | null {
  const [path, line, ...text] = row.split('\0')
  if (path === undefined || line === undefined || text.length === 0 || !/^\d+$/.test(line))
    return null
  return { path, line, text: text.join('\0') }
}

const DIRECTIVE_CONTEXT_LINES = 2
// An inline directive that can switch the rule off: any `eslint-disable*` comment, or an inline
// rule-config comment (`/* eslint <rule>: off */`).
const DIRECTIVE_START = /eslint-disable|\/\*\s*eslint\s/
// A disable that names no rule switches every rule off, this one included. A block comment that
// ends the line is not counted here: its rule list may wrap onto the next line.
const BARE_DISABLE =
  /(?:\/\*\s*eslint-disable(?:-next-line|-line)?\s*(?:\*\/|--)|\/\/\s*eslint-disable(?:-next-line|-line)?\s*(?:--|$))/

/** Check 1: grep context (-A2) so a directive wrapped over a few lines is still seen. */
function findInlineDirectives(repoRoot: string): PolicyFinding[] {
  const excludes = [...SELF_PATHS, ...NEVER_SCANNED].map((p) => `:(exclude,glob)${p}`)
  const out = gitGrep(repoRoot, [
    '-z',
    '-n',
    '-A2',
    '-E',
    '-e',
    'eslint-disable',
    '-e',
    '/\\*[[:space:]]*eslint[[:space:]]',
    '--',
    '.',
    ...excludes,
  ])
  const findings: PolicyFinding[] = []
  let directive: GrepRow | null = null
  let seen = 0
  for (const row of out.split('\n').map(parseGrepRow)) {
    if (row === null) {
      directive = null
      continue
    }
    if (DIRECTIVE_START.test(row.text)) {
      directive = row
      seen = 0
      if (BARE_DISABLE.test(row.text)) {
        findings.push({
          location: `${row.path}:${row.line}`,
          reason: `eslint disable without a rule list (switches off ${RULE} too)`,
        })
        directive = null
        continue
      }
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

const SHARED_POLICY = 'packages/eslint-config/index.js'
const ESLINT_CONFIG_NAME = /^eslint\.config\.[cm]?[jt]s$/

function isEslintConfig(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return ESLINT_CONFIG_NAME.test(name) || name.startsWith('.eslintrc')
}

/** Check 5: the rule's configuration lives only in the shared policy, not in a package config. */
function findConfigOverrides(repoRoot: string): PolicyFinding[] {
  const configs = git(repoRoot, ['ls-files'])
    .split('\n')
    .filter((path) => isEslintConfig(path) && path !== SHARED_POLICY)
  if (configs.length === 0) return []
  const out = gitGrep(repoRoot, [
    '-z',
    '-n',
    '-F',
    '-e',
    RULE,
    '--',
    ...configs.map((p) => `:(literal)${p}`),
  ])
  return out
    .split('\n')
    .map(parseGrepRow)
    .filter((row): row is GrepRow => row !== null)
    .map((row) => ({
      location: `${row.path}:${row.line}`,
      reason: `eslint config sets ${RULE}; the policy lives only in ${SHARED_POLICY}`,
    }))
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
// Any other value export (`export { x } from 'node:fs'`, `export *`, `export default`, `export let`,
// `export class`) would hand out file access with no reason, so a pinned module may not use one.
const OTHER_VALUE_EXPORT = /^export\s(?!async\sfunction\b|function\b|const\b|type\b|interface\b)/
const REASON_LINE = /Reason:\s*\S/

/** The JSDoc block ending on the line above `index`, or null when that line does not close a comment. */
function docBlockAbove(lines: string[], index: number): string[] | null {
  if (lines.at(index - 1)?.trim() !== '*/') return null
  const block: string[] = []
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const line = lines.at(cursor) ?? ''
    block.push(line)
    // Stop at the first comment opener: a plain `/*` block is not JSDoc, and walking further would
    // borrow the Reason: of an earlier export.
    if (line.trim().startsWith('/*')) return line.trim().startsWith('/**') ? block : null
  }
  return null
}

/** Check 3: every exported function/const of a pinned module is preceded by a JSDoc with `Reason:`. */
function findMissingReasons(repoRoot: string, path: string): PolicyFinding[] {
  const lines = (trackedText(repoRoot, path) ?? '').split('\n')
  const findings: PolicyFinding[] = []
  lines.forEach((text, index) => {
    if (OTHER_VALUE_EXPORT.test(text)) {
      findings.push({
        location: `${path}:${index + 1}`,
        reason: 'only `export function` / `export const` with a Reason: JSDoc may be exported',
      })
      return
    }
    const name = EXPORT_DECL.exec(text)?.[1]
    if (!name) return
    const block = docBlockAbove(lines, index)
    if (block?.some((line) => REASON_LINE.test(line))) return
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
    ...findConfigOverrides(repoRoot),
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
