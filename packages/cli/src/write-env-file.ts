/**
 * Story 43.5 AC-7 — materializing a scoped set of secrets as a file, as a seam consumable by a
 * non-CLI caller (Epic 50 / FR177's `write_env_file` "builds on the same injection primitive as
 * FR158/FR159 rather than a parallel implementation"). Zero imports of `commander`, `cli.ts`,
 * `CliRuntime`, or `process.argv` — `write-env-file.non-cli-caller.test.ts` proves it.
 * `write-env-command.ts` is the thin CLI adapter.
 *
 * Order of operations (Task 4):
 *   reserved/duplicate targets (1) → pre-flight lstat (25/26) → git-ignore warning (AC-9)
 *   → fail-closed fetch (shared with `pvault run`) → serialize, refusing BEFORE any temp file (27)
 *   → dotenv-only-quoting warning (AC-6) → synchronous atomic 0600 write (25 on a race, 28)
 */
import { lstatSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { writeFileAtomicOwnerOnly, type AtomicFs } from './atomic-file.js'
import { refusalMessage, serializeEnvFile, type EnvFileFormat } from './env-file-format.js'
import { EXIT_CODES } from './exit-codes.js'
import {
  checkEntryTargets,
  fetchAllOrNothing,
  type EntryFailure,
  type FetchSecretsDeps,
  type InjectEntry,
} from './fetch-secrets.js'
import { checkGitIgnored as realCheckGitIgnored, type GitIgnoreStatus } from './git-ignore-check.js'
import { isValidEnvVarIdentifier, SAFE_ENV_VAR_REGEX } from './reserved-env-vars.js'
import { sanitizeForTerminal } from './sanitize.js'

export type WriteEnvFileOptions = {
  format: EnvFileFormat
  /** Replace an existing regular file or symlink at the target (never a directory/device). */
  force: boolean
}

export type WriteEnvFileDeps = FetchSecretsDeps & {
  /** Base for a relative `target`; defaults to `process.cwd()`. */
  cwd?: string
  /** Filesystem seam for the atomic writer (fault injection in tests). */
  fs?: AtomicFs
  /** AC-9 seam; defaults to a real `git check-ignore`. */
  checkGitIgnored?: (dir: string, name: string) => Promise<GitIgnoreStatus>
}

export type WriteEnvFileResult =
  | { ok: true; exitCode: 0; path: string; count: number; servedFromCacheCount: number }
  | EntryFailure

/** Documented in README so a user can recognise a temp file stranded by SIGKILL/power loss. */
export const WRITE_ENV_TEMP_PREFIX = '.pvault-write-env.'

function noop(): void {
  // Default writeStderr when the caller doesn't supply one.
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

function failure(exitCode: number, error: string): EntryFailure {
  return { ok: false, exitCode, error }
}

function writeFailed(safePath: string, error: unknown): EntryFailure {
  const code = errorCode(error)
  return failure(
    EXIT_CODES.outputWriteFailed,
    `Failed to write '${safePath}': ${code ? sanitizeForTerminal(code) : 'unknown error'}`
  )
}

function parentMissing(safePath: string): EntryFailure {
  return failure(
    EXIT_CODES.outputPathInvalid,
    `Cannot write '${safePath}': its parent directory does not exist (or is not a directory). pvault write-env never creates directories.`
  )
}

function isDirectory(safePath: string): EntryFailure {
  return failure(
    EXIT_CODES.outputPathInvalid,
    `'${safePath}' is a directory (or ends with a path separator); --output must name a file.`
  )
}

function checkParent(path: string, safePath: string): EntryFailure | null {
  let parent: Stats
  try {
    parent = statSync(dirname(path))
  } catch {
    return parentMissing(safePath)
  }
  return parent.isDirectory() ? null : parentMissing(safePath)
}

/**
 * Pre-flight (Dev Notes decision #6): fast, pre-network feedback. `lstat`, never `stat`/`exists`,
 * so a symlink (even a dangling one) is seen as itself. The atomic commit re-enforces the
 * "exists" rule race-safely; this is not the guarantee, only the early answer.
 */
function preflight(rawTarget: string, path: string, force: boolean): EntryFailure | null {
  const safePath = sanitizeForTerminal(path)
  if (/[\\/]$/.test(rawTarget)) return isDirectory(safePath)

  let stats: Stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return checkParent(path, safePath)
    if (code === 'ENOTDIR') return parentMissing(safePath)
    return writeFailed(safePath, error)
  }

  if (stats.isDirectory()) return isDirectory(safePath)
  if (!stats.isFile() && !stats.isSymbolicLink()) {
    return failure(
      EXIT_CODES.outputPathInvalid,
      `'${safePath}' is not a regular file (FIFO, socket, or device); refusing to write to it, even with --force.`
    )
  }
  if (!force) return outputExists(safePath)
  return null
}

function outputExists(safePath: string): EntryFailure {
  return failure(EXIT_CODES.outputExists, `'${safePath}' already exists; pass --force to overwrite`)
}

async function warnIfNotGitIgnored(
  path: string,
  check: (dir: string, name: string) => Promise<GitIgnoreStatus>,
  writeStderr: (chunk: string) => void
): Promise<void> {
  let status: GitIgnoreStatus
  try {
    status = await check(dirname(path), basename(path))
  } catch {
    return // fail-open
  }
  if (status === 'not-ignored') {
    writeStderr(
      `warning: '${sanitizeForTerminal(path)}' is inside a git repository and is not gitignored; add it to .gitignore before committing\n`
    )
  }
}

/** AC-2 — every value is checked before any temp file exists; AC-6 — the dotenv-only warning. */
function serializeOrRefuse(
  entries: InjectEntry[],
  injected: Record<string, string>,
  format: EnvFileFormat,
  writeStderr: (chunk: string) => void
): { ok: true; text: string } | EntryFailure {
  const serialized = serializeEnvFile(
    entries.map((entry) => ({ key: entry.envVarName, value: injected[entry.envVarName] ?? '' })),
    format
  )
  if (!serialized.ok) {
    const refused = entries.find((entry) => entry.envVarName === serialized.key)
    const safeCredential = sanitizeForTerminal(refused?.credentialName ?? serialized.key)
    return failure(
      EXIT_CODES.valueNotRepresentable,
      `Cannot write '${safeCredential}' (as ${serialized.key}) in ${format} format: its value ${refusalMessage(serialized.reason)}. Nothing was written.`
    )
  }

  const dotenvOnly = serialized.dotenvOnlyQuotedKeys
  if (dotenvOnly.length > 0) {
    const verb = dotenvOnly.length === 1 ? 'uses' : 'use'
    writeStderr(
      `warning: ${dotenvOnly.join(', ')} ${verb} dotenv-only quoting; do not 'source' this file from a shell — use --format shell for that\n`
    )
  }
  return { ok: true, text: serialized.text }
}

/** AC-3 — exclusive (link/wx) unless `force`, in which case an atomic rename. */
function commit(
  path: string,
  text: string,
  force: boolean,
  fs: AtomicFs | undefined
): EntryFailure | null {
  try {
    writeFileAtomicOwnerOnly(
      path,
      text,
      { exclusive: !force, tempPrefix: WRITE_ENV_TEMP_PREFIX },
      fs
    )
    return null
  } catch (error) {
    // Only the error's `code` and the sanitized path are ever reported — never the error object,
    // its message, or its stack (`text`, holding every value, is in scope here).
    const safePath = sanitizeForTerminal(path)
    if (!force && errorCode(error) === 'EEXIST') return outputExists(safePath)
    return writeFailed(safePath, error)
  }
}

/**
 * A non-CLI caller (AC-7) bypasses `parseRunSecrets`' identifier check, and the serializer would
 * only reject a malformed key AFTER every secret was revealed (and audited). Refuse it up front.
 */
function checkIdentifiers(entries: InjectEntry[]): EntryFailure | null {
  const bad = entries.find((entry) => !isValidEnvVarIdentifier(entry.envVarName))
  if (!bad) return null
  return failure(
    EXIT_CODES.usageError,
    `Invalid environment variable name '${sanitizeForTerminal(bad.envVarName)}' — it must match ${SAFE_ENV_VAR_REGEX.source}.`
  )
}

export async function writeEnvFile(
  entries: InjectEntry[],
  target: string,
  options: WriteEnvFileOptions,
  deps: WriteEnvFileDeps
): Promise<WriteEnvFileResult> {
  const writeStderr = deps.writeStderr ?? noop

  const invalid = checkIdentifiers(entries) ?? checkEntryTargets(entries, 'write')
  if (invalid) return invalid

  const path = resolve(deps.cwd ?? process.cwd(), target)
  const preflightFailure = preflight(target, path, options.force)
  if (preflightFailure) return preflightFailure

  await warnIfNotGitIgnored(path, deps.checkGitIgnored ?? realCheckGitIgnored, writeStderr)

  const fetched = await fetchAllOrNothing(entries, { getSecret: deps.getSecret, writeStderr })
  if (!fetched.ok) return fetched

  const serialized = serializeOrRefuse(entries, fetched.injected, options.format, writeStderr)
  if (!serialized.ok) return serialized

  const commitFailure = commit(path, serialized.text, options.force, deps.fs)
  if (commitFailure) return commitFailure

  return {
    ok: true,
    exitCode: 0,
    path,
    count: entries.length,
    servedFromCacheCount: fetched.servedFromCacheCount,
  }
}
