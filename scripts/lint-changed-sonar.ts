#!/usr/bin/env tsx
/**
 * Story 66-17: the local, pre-PR reproduction of the static-analysis findings that kept reaching
 * SonarCloud only after push (Epic 66 retro Finding 1, Epic 68 retro Finding 2). pick-story's C3
 * gate runs this single command instead of a hand-written list of `--rule` flags:
 *
 *   pnpm lint:changed            # files changed against origin/main (committed, staged, unstaged, untracked)
 *   pnpm lint:changed -- --base main
 *
 * It runs, over the changed files only, and exits non-zero on any hit (printing the rule key):
 *   1. ESLint with the repo config plus the Sonar rules that are locally reproducible
 *      (`PV_SONAR_LOCAL=1` switches on `SONAR_LOCAL_RULE_NAMES` in packages/eslint-config; the
 *      rules that are clean repo-wide, `no-await-in-loop` (S9382), `no-alphabetical-sort` (S2871),
 *      S4634, S3699, S4043 and the three test rules, are in the committed config already);
 *   2. `shelldre:S7679` over changed `*.sh` files (scripts/check-shell-positional-params.ts), and
 *      `shellcheck` when it is installed (a notice, not a failure, when it is not);
 *   3. the suppression scan of pick-story C3 over the added lines (the seven tokens in
 *      SUPPRESSION_TOKENS: Sonar, ESLint, TypeScript, jscpd, istanbul and c8 suppressions): any
 *      hit fails, new suppressions are refused (AGENTS.md quality-gate exception process).
 *
 * Still post-push-only (no local equivalent): see "Post-push-only Sonar rules" in
 * ~/specs/pv-cm-sonarcloud.md. `--no-eslint` skips step 1 (the script's own tests use it).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkShellFiles } from './check-shell-positional-params.js'
import { resolveBin, resolveTrustedExecutable, trustedGit } from './lib/trusted-executable.js'

export type LintChangedOptions = { base: string; eslint: boolean }

// Built by concatenation so this file never contains the tokens it hunts for (the repo guard
// check-no-sonar-suppressions and the review scan would otherwise flag it).
const SUPPRESSION_TOKENS = [
  'NO' + 'SONAR',
  'eslint-' + 'disable',
  '@ts-' + 'ignore',
  '@ts-' + 'expect-error',
  'jscpd:' + 'ignore',
  'istanbul ' + 'ignore',
  'c8 ' + 'ignore',
]
const containsSuppression = (text: string): boolean =>
  SUPPRESSION_TOKENS.some((token) => text.includes(token))

const TYPED_EXTENSIONS = new Set(['.ts', '.tsx'])
const ESLINT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.svelte'])
// Files that are never linted: generated output, vendored code and the private overlay symlinks.
const SKIPPED_PREFIXES = ['_bmad', '.claude/', 'packages/db/src/migrations/']
const SKIPPED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'coverage', '.svelte-kit'])
// The private overlay and tooling are not analysed by Sonar either.
const SUPPRESSION_SCAN_SKIPPED = ['_bmad-output/', '_bmad/', '.claude/', 'pnpm-lock.yaml']

export function parseArgs(argv: readonly string[]): LintChangedOptions {
  const options: LintChangedOptions = { base: 'origin/main', eslint: true }
  let skipNext = -1
  for (const [i, arg] of argv.entries()) {
    if (skipNext === i) continue
    if (arg === '--base') {
      const value = argv.at(i + 1)
      if (value === undefined || value.startsWith('--')) throw new Error('--base needs a ref')
      options.base = value
      skipNext = i + 1
    } else if (arg === '--no-eslint') {
      options.eslint = false
    } else if (arg !== '--') {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot)
}

/** Splits changed paths into what ESLint lints, which shell scripts exist, and what is ignored. */
function isNeverLinted(path: string): boolean {
  return (
    SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    path.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment))
  )
}

export function classifyFiles(paths: readonly string[]): { lint: string[]; shell: string[] } {
  const kept = paths.filter((p) => !isNeverLinted(p))
  return {
    lint: kept.filter((p) => ESLINT_EXTENSIONS.has(extensionOf(p))),
    shell: kept.filter((p) => extensionOf(p) === '.sh'),
  }
}

/** Added lines of a `git diff -U0` text that carry a suppression token, as `path:line: text`. */
export function addedSuppressions(diff: string): string[] {
  const hits: string[] = []
  let path = ''
  let line = 0
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      path = row.startsWith('+++ b/') ? row.slice(6) : ''
      continue
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(row)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!row.startsWith('+') || row.startsWith('+++')) continue
    const text = row.slice(1)
    if (path !== '' && !isScanSkipped(path) && containsSuppression(text)) {
      hits.push(`${path}:${line}: ${text.trim()}`)
    }
    line += 1
  }
  return hits
}

/** The same scan over the whole content of a new, untracked file. */
export function suppressionsInNewFile(path: string, content: string): string[] {
  if (isScanSkipped(path)) return []
  return content
    .split('\n')
    .flatMap((text, index) =>
      containsSuppression(text) ? [`${path}:${index + 1}: ${text.trim()}`] : []
    )
}

function isScanSkipped(path: string): boolean {
  return SUPPRESSION_SCAN_SKIPPED.some((prefix) => path.startsWith(prefix))
}

function lines(output: string): string[] {
  return output.split('\n').filter((l) => l !== '')
}

function resolveBase(root: string, base: string): string {
  for (const candidate of [base, 'main']) {
    try {
      return trustedGit(root, ['merge-base', 'HEAD', candidate]).trim()
    } catch {
      // try the next candidate (a cloud session may have no origin/main ref)
    }
  }
  throw new Error(`cannot resolve a merge base against ${base} or main`)
}

type ChangeSet = { files: string[]; untracked: string[]; diff: string }

function collectChanges(root: string, mergeBase: string): ChangeSet {
  const tracked = lines(trustedGit(root, ['diff', '--name-only', '--diff-filter=ACMR', mergeBase]))
  const untracked = lines(trustedGit(root, ['ls-files', '--others', '--exclude-standard']))
  const diff = trustedGit(root, ['diff', '-U0', '--diff-filter=ACMR', mergeBase])
  return {
    files: [...new Set([...tracked, ...untracked])].filter((p) => existsSync(resolve(root, p))),
    untracked,
    diff,
  }
}

/** The `include` entries of a tsconfig (comments tolerated), or `null` when it has none. */
function tsconfigIncludes(tsconfigText: string): string[] | null {
  const withoutComments = tsconfigText.replaceAll(/^\s*\/\/.*$/gm, '')
  const keyAt = withoutComments.indexOf('"include"')
  if (keyAt === -1) return null
  let cursor = keyAt + '"include"'.length
  while (/\s/.test(withoutComments.charAt(cursor))) cursor++
  if (withoutComments.charAt(cursor) !== ':') return null
  cursor++
  while (/\s/.test(withoutComments.charAt(cursor))) cursor++
  if (withoutComments.charAt(cursor) !== '[') return null
  const close = withoutComments.indexOf(']', cursor)
  if (close === -1) return null
  const body = withoutComments.slice(cursor + 1, close)
  return [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? '')
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** Whether `include` (tsconfig globs relative to its directory) covers `relativePath`. */
function includeCovers(include: readonly string[], relativePath: string): boolean {
  return include.some((glob) => {
    const prefix = glob.split('*')[0] ?? ''
    return relativePath.startsWith(prefix)
  })
}

/**
 * The changed `.ts`/`.tsx` files that no package tsconfig `include`s (root `scripts/`,
 * `apps/web/scripts/`, root config files). The type-aware Sonar rules (S2871, S4043, S1874) need
 * type information, and typescript-eslint's project service only parses such files when they are
 * listed in `allowDefaultProject`; listing a file a tsconfig DOES cover is itself an error, so
 * the two sets must be disjoint.
 */
export function filesOutsideTsProjects(
  root: string,
  files: readonly string[],
  read: (path: string) => string | null = (path) =>
    existsSync(path) ? readFileSync(path, 'utf-8') : null
): string[] {
  return files
    .filter((file) => TYPED_EXTENSIONS.has(extensionOf(file)))
    .filter((file) => {
      for (let dir = directoryOf(file); ; dir = directoryOf(dir)) {
        const prefix = dir === '' ? '' : `${dir}/`
        const text = read(resolve(root, `${prefix}tsconfig.json`))
        if (text !== null) {
          const include = tsconfigIncludes(text)
          return include === null || !includeCovers(include, file.slice(prefix.length))
        }
        if (dir === '') return true
      }
    })
}

function runEslint(root: string, files: string[]): number {
  if (files.length === 0) return 0
  const eslint = resolveBin('eslint', 'eslint', root)
  const result = spawnSync(process.execPath, [eslint, '--no-warn-ignored', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PV_SONAR_LOCAL: '1',
      PV_SONAR_LOCAL_FILES: filesOutsideTsProjects(root, files).join('\n'),
    },
  })
  return result.status ?? 1
}

function runShellcheck(root: string, files: string[]): number {
  if (files.length === 0) return 0
  try {
    const shellcheck = resolveTrustedExecutable('shellcheck')
    return spawnSync(shellcheck, files, { cwd: root, stdio: 'inherit' }).status ?? 1
  } catch {
    process.stderr.write(
      'notice: shellcheck is not installed, skipped (the S7679 guard still ran)\n'
    )
    return 0
  }
}

export function main(argv: readonly string[], root = process.cwd()): number {
  const options = parseArgs(argv)
  const mergeBase = resolveBase(root, options.base)
  const changes = collectChanges(root, mergeBase)
  const { lint, shell } = classifyFiles(changes.files)
  let failed = false

  if (options.eslint) {
    if (runEslint(root, lint) !== 0) {
      failed = true
      process.stderr.write(
        'lint:changed: ESLint (repo config + local Sonar rules) reported errors\n'
      )
    }
  }

  const shellProblems = checkShellFiles(shell.map((p) => resolve(root, p)))
  if (shellProblems.length > 0) {
    failed = true
    process.stderr.write(`${shellProblems.join('\n')}\n`)
  }
  if (runShellcheck(root, shell) !== 0) {
    failed = true
    process.stderr.write('lint:changed: shellcheck reported problems\n')
  }

  const suppressions = [
    ...addedSuppressions(changes.diff),
    ...changes.untracked.flatMap((p) =>
      suppressionsInNewFile(p, readFileSync(resolve(root, p), 'utf-8'))
    ),
  ]
  if (suppressions.length > 0) {
    failed = true
    process.stderr.write(
      `suppression(s) added (refused, see AGENTS.md quality-gate exceptions):\n${suppressions.join('\n')}\n`
    )
  }

  process.stdout.write(
    `lint:changed: ${lint.length} lintable, ${shell.length} shell file(s) vs ${options.base}: ${failed ? 'FAILED' : 'clean'}\n`
  )
  return failed ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(
      `lint:changed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(2)
  }
}
