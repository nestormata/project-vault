/**
 * Story 66-19 (epic-66 retro Finding 3, a REPEAT 3x): the one sanctioned way to script-edit the
 * shared private-tree files (`deferred-work.md`, `sprint-status.yaml`).
 *
 * `open(p, 'w').write(f(open(p).read()))` truncates the file BEFORE `f` runs, so an exception in
 * `f` leaves a 0-byte ledger. Here the new content is computed completely in memory first, refused
 * when empty or when it shrinks the file past a ratio, and only then swapped in with a same-directory
 * temp file + `rename` (atomic on POSIX). A concurrent writer between read and rename is detected
 * by a content-hash re-check (one retry, then a clear error); it is detected, not prevented. Appends
 * are a single `O_APPEND` write and cannot interleave. `withFileLock` gives callers a critical
 * section across processes that share the same directory.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type EditOptions = {
  /** Largest tolerated fractional size loss (default 0.5); pass a larger value for a deliberate cut. */
  maxShrinkRatio?: number
}

const DEFAULT_MAX_SHRINK_RATIO = 0.5

/** Pure core: the edited content, or a throw (callback error, empty result, over-shrink). */
export function computeEdit(
  original: string,
  edit: (content: string) => string,
  options: EditOptions = {}
): string {
  const next = edit(original)
  if (next.trim() === '') {
    throw new Error('safeEditFile: the edit produced empty content; refusing to write it')
  }
  const ratio = options.maxShrinkRatio ?? DEFAULT_MAX_SHRINK_RATIO
  const before = Buffer.byteLength(original)
  const after = Buffer.byteLength(next)
  if (before > 0 && (before - after) / before > ratio) {
    throw new Error(
      `safeEditFile: the edit shrinks the file from ${before} to ${after} bytes ` +
        `(more than ${ratio * 100}%); pass maxShrinkRatio if this is deliberate`
    )
  }
  return next
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function attemptEdit(
  real: string,
  edit: (content: string) => string,
  options: EditOptions,
  retriesLeft: number
): void {
  try {
    accessSync(real, constants.W_OK)
  } catch {
    throw new Error(`safeEditFile: ${real} is not writable`)
  }
  const before = readFileSync(real, 'utf-8')
  const next = computeEdit(before, edit, options)
  const mode = statSync(real).mode & 0o7777
  const temp = join(
    dirname(real),
    `.${basename(real)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  )
  try {
    writeFileSync(temp, next, { flag: 'wx', mode })
    chmodSync(temp, mode)
    if (sha256(readFileSync(real, 'utf-8')) !== sha256(before)) {
      rmSync(temp, { force: true })
      if (retriesLeft > 0) return attemptEdit(real, edit, options, retriesLeft - 1)
      throw new Error(
        `safeEditFile: file changed by another writer during the edit (retried once): ${real}`
      )
    }
    renameSync(temp, real)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Atomically replaces `path`'s content with `edit(current)`; edits the symlink target. */
export function safeEditFile(
  path: string,
  edit: (content: string) => string,
  options: EditOptions = {}
): void {
  attemptEdit(realpathSync(path), edit, options, 1)
}

/** Appends `text` in one `O_APPEND` write; never creates the file; follows a symlink. */
export function appendToFile(path: string, text: string): void {
  const real = realpathSync(path)
  const fd = openSync(real, constants.O_WRONLY | constants.O_APPEND)
  try {
    writeSync(fd, Buffer.from(text, 'utf-8'))
  } finally {
    closeSync(fd)
  }
}

export type LockOptions = {
  /** Clock used for the lock's embedded time and the stale check (default `new Date()`). */
  now?: () => Date
  /** A lock older than this (by embedded time) is taken over (default 30 s). */
  staleMs?: number
  /** How long to wait for a held lock before failing closed (default 10 s). */
  timeoutMs?: number
  /** Delay between acquisition attempts (default 50 ms). */
  pollMs?: number
  /** Receives the stale-takeover warning (default: stderr). */
  warn?: (message: string) => void
}

const DEFAULT_STALE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 50

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

/** The embedded time of an existing lock file, or undefined when it cannot be read/parsed. */
function lockTimestamp(lockPath: string): number | undefined {
  try {
    const iso = readFileSync(lockPath, 'utf-8').trim().split(/\s+/)[1]
    const parsed = iso === undefined ? Number.NaN : Date.parse(iso)
    return Number.isNaN(parsed) ? undefined : parsed
  } catch {
    return undefined
  }
}

function tryCreateLock(lockPath: string, now: Date): boolean {
  try {
    writeFileSync(lockPath, `${process.pid} ${now.toISOString()}\n`, { flag: 'wx' })
    return true
  } catch (error) {
    if (isExistsError(error)) return false
    throw error
  }
}

/** Moves a stale lock aside atomically (only one racing process wins the rename). */
function takeOverStale(lockPath: string, warn: (message: string) => void): void {
  const aside = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    renameSync(lockPath, aside)
  } catch {
    return // someone else already took it over
  }
  rmSync(aside, { force: true })
  warn(`stale lock ${lockPath} taken over`)
}

function acquire(lockPath: string, options: LockOptions, deadline: number): void {
  const now = options.now ?? (() => new Date())
  if (tryCreateLock(lockPath, now())) return
  const stamp = lockTimestamp(lockPath)
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  if (stamp !== undefined && now().getTime() - stamp > staleMs) {
    takeOverStale(
      lockPath,
      options.warn ?? ((message) => process.stderr.write(`WARN: ${message}\n`))
    )
    return acquire(lockPath, options, deadline)
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `withFileLock: could not acquire ${lockPath} (held by another process); nothing was changed`
    )
  }
  sleepSync(options.pollMs ?? DEFAULT_POLL_MS)
  return acquire(lockPath, options, deadline)
}

/**
 * Runs `fn` while holding the exclusive lock file `lockPath` (created with `O_EXCL`, containing
 * pid + ISO time, removed in `finally`). Keep the lock next to the protected file, never in
 * `os.tmpdir()`: per-session sandboxes can have different temp dirs and would not exclude each other.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  acquire(lockPath, options, Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  try {
    return fn()
  } finally {
    rmSync(lockPath, { force: true })
  }
}
