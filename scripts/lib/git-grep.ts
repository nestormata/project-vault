// Shared by the tracked-file guards (check-no-sonar-suppressions, check-fs-filename-policy): a
// `git grep` that treats "no match" as empty output, and the common failure report.
import { trustedGit } from './trusted-executable.js'

export type GuardFinding = { location: string; reason: string }

/**
 * `git grep` over tracked work-tree files, or `''` when nothing matches (its exit 1); any other
 * failure surfaces. Every file a guard reads this way is tracked content addressed by
 * repo-relative pathspecs.
 */
export function gitGrep(repoRoot: string, args: string[]): string {
  try {
    return trustedGit(repoRoot, ['grep', '--no-color', '-I', ...args])
  } catch (error) {
    if ((error as { status?: number }).status === 1) return ''
    throw error
  }
}

/** Prints a failing guard's headline plus one `location  reason` line per finding; sets exit code 1. */
export function reportFindings(headline: string, findings: GuardFinding[]): void {
  process.stderr.write(`${headline}\n`)
  for (const f of findings) process.stderr.write(`  ${f.location}  ${f.reason}\n`)
  process.exitCode = 1
}
