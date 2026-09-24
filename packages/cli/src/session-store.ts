import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicOwnerOnly } from './atomic-file.js'

// AC-1/AC-7 decision #1 — file-based session storage (not a platform keychain — see
// packages/cli/README.md "Decisions" for the full rationale). AC-1's XDG-first, HOME-fallback
// location, mirroring most modern CLIs (e.g. `gh`, `kubectl` config conventions).

export type EnvLike = Record<string, string | undefined>

/** AC-7 decision #2 — everything Story 51.2 (browser extension login) must reuse: the token
 * type, issuance endpoint(s), and lifetime. The `baseUrl` field lets every other CLI command
 * re-derive which vault a stored session belongs to without a redundant `--url` flag. */
export type SessionData = {
  accessToken: string
  refreshToken: string
  /** ISO-8601 — the access JWT's own expiry, used for the silent-refresh decision (AC-4). */
  accessExpiresAt: string
  userId: string
  orgId: string
  baseUrl: string
}

export type SessionReadResult =
  | { status: 'ok'; session: SessionData }
  | { status: 'not_found' }
  /** AC-5 — a session file that exists but is group/world-readable. Kept distinct from
   * `not_found` since the fix ("chmod 600" or re-login) is different from "just log in". */
  | { status: 'insecure_permissions'; path: string }

const DIR_MODE = 0o700

/**
 * Creates `dir` (recursively) owner-only (`0700`). Shared by the session file and Story 43.6's
 * version-check cache, which live in the same directory.
 */
export function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try {
    chmodSync(dir, DIR_MODE)
  } catch {
    // Best-effort — the file-level chmod done by the atomic writer is the hard guarantee; a chmod
    // failure on the directory itself (e.g. a read-only parent) surfaces later via the write
    // failing anyway.
  }
}

export function sessionDir(env: EnvLike = process.env): string {
  const xdg = env['XDG_CONFIG_HOME']
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
  return join(base, 'pvault')
}

export function sessionFilePath(env: EnvLike = process.env): string {
  return join(sessionDir(env), 'session.json')
}

function isSessionData(value: unknown): value is SessionData {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['accessExpiresAt'] === 'string' &&
    typeof v['userId'] === 'string' &&
    typeof v['orgId'] === 'string' &&
    typeof v['baseUrl'] === 'string'
  )
}

/**
 * AC-1 — writes the session file atomically (temp file in the same directory, `fsync`ed, then
 * `fs.renameSync` over the real path) so a concurrent reader (AC-4's concurrency edge case) never
 * observes a torn/partial write, and with explicit `0600`/`0700` permissions enforced via a
 * follow-up `chmodSync` rather than relying on `writeFileSync`'s `mode` option alone (which
 * `umask` can widen on some platforms).
 */
export function writeSession(session: SessionData, env: EnvLike = process.env): void {
  ensureOwnerOnlyDir(sessionDir(env))

  // Story 43.5 Task 2 — the temp-file/fsync/chmod/rename sequence now lives in atomic-file.ts
  // (shared with `pvault write-env`); `exclusive: false` keeps this function's replace semantics.
  const data = `${JSON.stringify(session, null, 2)}\n`
  writeFileAtomicOwnerOnly(sessionFilePath(env), data, {
    exclusive: false,
    tempPrefix: '.session.json.',
  })
}

/**
 * AC-5 — verifies the file's own permission bits (POSIX only; a no-op check on Windows, see
 * README) on *every* read, before ever parsing its contents, and refuses (hard stop, not a
 * warning) a group/world-readable file. AC-4's concurrency edge case: a file that exists but
 * fails to parse (e.g. a reader racing an in-progress writer that hasn't reached this function's
 * atomic rename yet) is folded into `not_found` rather than throwing — the caller's response is
 * the same either way ("not logged in, run `pvault login`").
 */
export function readSession(env: EnvLike = process.env): SessionReadResult {
  const path = sessionFilePath(env)
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { status: 'not_found' }
  }

  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777
    if ((mode & 0o077) !== 0) {
      return { status: 'insecure_permissions', path }
    }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { status: 'not_found' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'not_found' }
  }

  if (!isSessionData(parsed)) return { status: 'not_found' }
  return { status: 'ok', session: parsed }
}

/** AC-6 — idempotent: deleting an already-absent session file is success, not an error. */
export function deleteSession(env: EnvLike = process.env): { deleted: boolean } {
  const path = sessionFilePath(env)
  if (!existsSync(path)) return { deleted: false }
  try {
    unlinkSync(path)
    return { deleted: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: false }
    throw error
  }
}
