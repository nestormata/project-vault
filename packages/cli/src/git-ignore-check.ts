/**
 * Story 43.5 AC-9 — accidental-commit guard: is a materialized secrets file going to be picked up
 * by `git add .`? Warn-only and FAIL-OPEN: any outcome other than a definite "not ignored" (not a
 * repo, git missing, timeout, spawn error) resolves to `unknown`, which the caller treats as
 * silent. This check must never become a hard dependency of `pvault write-env`.
 *
 * The path is user-controlled, so git is spawned via `execFile` with an argv array (never a shell
 * string) and the name is passed after `--` as a single element.
 */
import { execFile } from 'node:child_process'

export type GitIgnoreStatus = 'ignored' | 'not-ignored' | 'unknown'

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
  callback: (error: (Error & { code?: number | string; killed?: boolean }) | null) => void
) => unknown

const TIMEOUT_MS = 2000

/** Repository-location overrides that would make git answer about some OTHER repository than the
 * one containing the target directory (e.g. when invoked from inside a git hook). */
const REPO_OVERRIDE_VARS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REPO_OVERRIDE_VARS.has(name))
  )
}

export function checkGitIgnored(
  dir: string,
  name: string,
  execFileImpl: ExecFileLike = execFile as unknown as ExecFileLike
): Promise<GitIgnoreStatus> {
  return new Promise((resolve) => {
    try {
      execFileImpl(
        'git',
        ['-C', dir, 'check-ignore', '-q', '--', name],
        { timeout: TIMEOUT_MS, env: gitEnv() },
        (error) => {
          if (!error) {
            resolve('ignored')
          } else if (error.code === 1 && !error.killed) {
            resolve('not-ignored')
          } else {
            resolve('unknown')
          }
        }
      )
    } catch {
      resolve('unknown')
    }
  })
}
