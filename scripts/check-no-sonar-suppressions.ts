#!/usr/bin/env tsx
/**
 * Story 43.9 AC-9 — fail CI on any Sonar suppression, so a green SonarCloud gate stays honest
 * evidence that the code is clean. (Story 43.16 removed the one signed-off scanner ignore this guard
 * used to accept; there are now zero exceptions.)
 *
 * Fails (exit 1, listing every offending `path:line`) when:
 *   1. any tracked file contains the Sonar inline-suppression token, matched case-insensitively.
 *      Skipped: this guard and its test, the private overlay (`_bmad-output/**`) and tooling
 *      (`.claude/**`), and every path `sonar.exclusions` in sonar-project.properties already
 *      keeps out of analysis (read from that file, so the two lists cannot drift);
 *   2. a `.github/workflows/*` file passes a scanner-side `sonar.issue.ignore`/`sonar.issue.enforce`
 *      setting (the obvious relocation of an ignore out of the properties file);
 *   3. sonar-project.properties has any `sonar.issue.ignore.*`/`sonar.issue.enforce.*` key.
 *
 * Out of scope: ESLint disable directives, TypeScript expect-error comments and similar. Those are
 * governed by pick-story C3's PR-time refusal of new suppressions; a repo-wide guard here would fail on the
 * pre-existing lines, whose sign-off audit is tracked in the deferred-work ledger.
 */
import { pathToFileURL } from 'node:url'
import { trustedGit } from './lib/trusted-executable.js'

export type SuppressionFinding = { location: string; reason: string }

// Built by concatenation so this file never contains the token it hunts for.
const TOKEN = 'NO' + 'SONAR'
const PROPERTIES_FILE = 'sonar-project.properties'
const SELF_PATHS = [
  'scripts/check-no-sonar-suppressions.ts',
  'scripts/check-no-sonar-suppressions.test.ts',
]
const NEVER_ANALYSED = ['_bmad-output/**', '.claude/**']

const ISSUE_KEY = /^sonar\.issue\.(?:ignore|enforce)\./i

type PropertyLine = { key: string; value: string; line: number }

const git = trustedGit

/** Parses `key=value` properties, joining `\`-continued lines; `line` is where the key starts. */
function parseProperties(text: string): { entries: PropertyLine[]; lines: string[] } {
  const lines = text.split('\n')
  const entries: PropertyLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const start = i
    const trimmed = (lines.at(i) ?? '').trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    let logical = trimmed
    while (logical.endsWith('\\') && i + 1 < lines.length) {
      i++
      logical = logical.slice(0, -1) + (lines.at(i) ?? '').trim()
    }
    entries.push({ ...splitKeyValue(logical), line: start + 1 })
  }
  return { entries, lines }
}

/** Resolves java.util.Properties key escapes: `\uXXXX` and `\<char>` (e.g. `\.`, `\ `). */
function unescapeKey(raw: string): string {
  return raw.replace(
    /\\(?:u([0-9a-fA-F]{4})|(.))/g,
    (_match, hex: string | undefined, ch: string) =>
      hex === undefined ? ch : String.fromCodePoint(Number.parseInt(hex, 16))
  )
}

/**
 * Splits one logical line the way java.util.Properties (which the scanner loads this file with)
 * does: the key ends at the first unescaped `=`, `:` or whitespace, so `key value` is as valid as
 * `key=value`, and the key's escapes are resolved before it is compared.
 */
function splitKeyValue(logical: string): { key: string; value: string } {
  const separator = /^((?:\\.|[^\\=:\s])*)\s*[=:]?\s*/.exec(logical)
  const rawKey = separator?.[1] ?? logical
  const consumed = separator?.[0].length ?? logical.length
  return { key: unescapeKey(rawKey), value: logical.slice(consumed).trim() }
}

/**
 * `git grep` over tracked work-tree files, or `''` when nothing matches (its exit 1); any other
 * failure surfaces. Every file this guard reads goes through git, so it only ever sees tracked
 * content addressed by repo-relative pathspecs, exactly like the inline-token scan.
 */
function gitGrep(repoRoot: string, args: string[]): string {
  try {
    return git(repoRoot, ['grep', '--no-color', '-I', ...args])
  } catch (error) {
    if ((error as { status?: number }).status === 1) return ''
    throw error
  }
}

function readProperties(repoRoot: string): ReturnType<typeof parseProperties> | null {
  // `^` matches every line (blank ones included), so this is the whole tracked file verbatim.
  const text = gitGrep(repoRoot, ['-h', '-e', '^', '--', `:(literal)${PROPERTIES_FILE}`])
  return text === '' ? null : parseProperties(text)
}

function sonarExclusions(properties: ReturnType<typeof parseProperties> | null): string[] {
  const value = properties?.entries.find((e) => e.key === 'sonar.exclusions')?.value ?? ''
  return value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

function findInlineTokens(repoRoot: string, excluded: string[]): SuppressionFinding[] {
  const pathspecs = [...SELF_PATHS, ...NEVER_ANALYSED, ...excluded].map(
    (pattern) => `:(exclude,glob)${pattern}`
  )
  return gitGrep(repoRoot, ['-n', '-i', '-e', TOKEN, '--', '.', ...pathspecs])
    .split('\n')
    .filter(Boolean)
    .map((hit) => {
      const [path, line] = hit.split(':', 2)
      return { location: `${path}:${line}`, reason: `inline ${TOKEN} suppression` }
    })
}

function findWorkflowIgnores(repoRoot: string): SuppressionFinding[] {
  const workflows = ['.github/workflows/**/*.yml', '.github/workflows/**/*.yaml'].map(
    (pattern) => `:(glob)${pattern}`
  )
  return gitGrep(repoRoot, [
    '-n',
    '-i',
    '-E',
    '-e',
    String.raw`sonar\.issue\.(ignore|enforce)`,
    '--',
    ...workflows,
  ])
    .split('\n')
    .filter(Boolean)
    .map((hit) => {
      const [path, line] = hit.split(':', 2)
      return {
        location: `${path}:${line}`,
        reason: 'scanner-side issue ignore passed from CI config',
      }
    })
}

/**
 * Every scanner-level `sonar.issue.ignore.*` / `sonar.issue.enforce.*` entry is a finding. Story
 * 43.16 removed the repo's last signed-off ignore (Story 43.9's interim `e1` on the Fly internal
 * hop) together with the code that accepted it; a future genuine exception needs an expert consult,
 * Nestor's sign-off (AGENTS.md) and a deliberate change to this guard.
 */
function findPropertyIgnores(
  properties: ReturnType<typeof parseProperties> | null
): SuppressionFinding[] {
  if (!properties) return []
  return properties.entries
    .filter((e) => ISSUE_KEY.test(e.key))
    .map((e) => ({
      location: `${PROPERTIES_FILE}:${e.line}`,
      reason: `${e.key} is a scanner-level issue ignore; fix the finding instead`,
    }))
}

/** Every Sonar suppression under `repoRoot` (a git work tree). Empty means clean. */
export function findSonarSuppressions(repoRoot: string): SuppressionFinding[] {
  const properties = readProperties(repoRoot)
  return [
    ...findInlineTokens(repoRoot, sonarExclusions(properties)),
    ...findWorkflowIgnores(repoRoot),
    ...findPropertyIgnores(properties),
  ]
}

function main(): void {
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const findings = findSonarSuppressions(repoRoot)
  if (findings.length === 0) {
    process.stdout.write('check-no-sonar-suppressions: OK — no Sonar suppressions.\n')
    return
  }
  process.stderr.write(
    `check-no-sonar-suppressions: ${findings.length} Sonar suppression(s). Fix the finding for real; a genuine exception needs an expert consult plus Nestor's sign-off (AGENTS.md).\n`
  )
  for (const f of findings) process.stderr.write(`  ${f.location}  ${f.reason}\n`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
