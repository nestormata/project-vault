#!/usr/bin/env tsx
/**
 * Story 68.10 AC-3.2: the in-workflow path filter of the `Mock UI pack mechanism e2e` job.
 *
 *   tsx scripts/mock-ui-pack-e2e-filter.ts <base-branch>
 *
 * Prints one explanatory line and `run=true|false` (to $GITHUB_OUTPUT when set, else stdout). It
 * diffs `origin/<base>...HEAD` (the job checks out with fetch-depth 0). ANY failure to compute the
 * diff (an unresolvable base, a shallow clone, a git error) FAILS OPEN to `run=true` and says why: a
 * diff error must never skip the job.
 */
import { REPO_ROOT } from './pack-web-host.js'
import { decide, type Decision } from './lib/mock-ui-pack-paths.js'
import { trustedGit } from './lib/trusted-executable.js'

export type DiffReader = (base: string) => string[]

const BASE_PATTERN = /^[A-Za-z0-9._/-]+$/

export function readDiff(base: string): string[] {
  const output = trustedGit(REPO_ROOT, ['diff', '--name-only', `origin/${base}...HEAD`])
  return output.split('\n').filter((line) => line !== '')
}

/** The decision for a PR against `base`; a diff error fails open. */
export function filterFor(base: string, read: DiffReader = readDiff): Decision {
  if (!BASE_PATTERN.test(base) || base.startsWith('-')) {
    return { run: true, reason: `unusable base ref "${base}": running the job` }
  }
  try {
    return decide(read(base))
  } catch (error) {
    const first = (error as Error).message.split('\n')[0] ?? 'diff failed'
    return { run: true, reason: `could not compute the diff (${first}): running the job` }
  }
}

function main(): void {
  const decision = filterFor(process.argv[2] ?? '')
  // stderr is the human line (it shows in the job log); stdout is exactly `run=true|false`, which the
  // workflow step appends to $GITHUB_OUTPUT itself, so this script does no filesystem write.
  process.stderr.write(`mock-ui-pack-e2e filter: ${decision.reason}\n`)
  process.stdout.write(`run=${decision.run ? 'true' : 'false'}\n`)
}

if (process.argv[1]?.endsWith('mock-ui-pack-e2e-filter.ts') === true) main()
