#!/usr/bin/env tsx
/**
 * Story 66-17: local guard for SonarCloud `shelldre:S7679` (a positional parameter used directly
 * inside a shell function). Usage: `tsx scripts/check-shell-positional-params.ts <file.sh>...`.
 * Exits 1 and prints `shelldre:S7679 <path>:<line>: <line text>` for every direct use; the fix is
 * to assign each positional parameter to a `local` at the top of the function.
 * `scripts/lint-changed-sonar.ts` runs it over the shell files changed against origin/main.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findPositionalParamUses } from './lib/shell-positional-params.js'

export const RULE_KEY = 'shelldre:S7679'

/** One report line per direct positional-parameter use in the given shell files. */
export function checkShellFiles(
  paths: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, 'utf-8')
): string[] {
  return paths.flatMap((path) =>
    findPositionalParamUses(read(path)).map((use) => `${RULE_KEY} ${path}:${use.line}: ${use.text}`)
  )
}

export function main(argv: readonly string[]): number {
  if (argv.length === 0) {
    process.stderr.write('usage: check-shell-positional-params <file.sh>...\n')
    return 2
  }
  const problems = checkShellFiles(argv)
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`)
    process.stderr.write(
      'Assign each positional parameter to a local at the top of the function (local name="$1").\n'
    )
    return 1
  }
  process.stdout.write(`${RULE_KEY}: ${argv.length} shell file(s) clean\n`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)))
}
