/**
 * Story 43.5 Task 2 (Grounding finding G5) — the atomic, owner-only file writer, extracted from
 * Story 43.2's `session-store.ts` `writeSession()` so `pvault write-env` reuses it rather than
 * cloning it (jscpd is a hard CI gate here).
 *
 * temp file in the same directory (opened `'wx'`, mode 0600) → write → `fsync` → explicit
 * `chmod 0600` (never trust `open`'s mode alone; `umask` can narrow it and some platforms widen
 * it) → commit → temp cleanup in `finally`.
 *
 * Commit is either:
 * - `exclusive: false` → `rename` (atomically replaces whatever is at `target`, including a
 *   symlink ITSELF; it never writes through the link or reuses the old inode/mode), or
 * - `exclusive: true` → `link(tmp, target)`, which fails with `EEXIST` if anything (even a
 *   dangling symlink) appeared at `target` in the meantime. Where `link` is unsupported (some
 *   FUSE/SMB mounts: `EPERM`/`ENOTSUP`), falls back to `open(target, 'wx', 0600)` + write + `fsync`:
 *   still an exclusive, race-safe create, just not an atomic rename. Never a non-exclusive write.
 *
 * Deliberately fully synchronous (no `await` anywhere): Node cannot run a SIGINT handler or any
 * other JS in the middle of it, so an interrupt lands either before the temp file exists or after
 * it has been committed and cleaned up. Only an uncatchable kill can strand a temp file.
 */
import * as nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

export type AtomicFs = Pick<
  typeof nodeFs,
  | 'openSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'chmodSync'
  | 'renameSync'
  | 'linkSync'
  | 'unlinkSync'
>

export type AtomicWriteOptions = {
  /** `true` → never replace an existing entry at `target` (fails with `EEXIST`). */
  exclusive: boolean
  /** Temp file name prefix, e.g. `.session.json.` → `.session.json.<hex>.tmp`. */
  tempPrefix: string
}

const FILE_MODE = 0o600
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function unlinkIfPresent(fs: AtomicFs, path: string): void {
  try {
    fs.unlinkSync(path)
  } catch {
    // Already gone (renamed away, or never created) — nothing to clean up.
  }
}

/** Writes `data` to an already-open fd and closes it, whatever happens. */
function writeAndClose(fs: AtomicFs, fd: number, data: string): void {
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Story 43.5 A4 — `'wx'` (O_CREAT|O_EXCL) refuses any pre-existing entry at the random temp
 * name, including a planted symlink; one retry with a fresh name on `EEXIST`. */
function openTemp(fs: AtomicFs, dir: string, prefix: string): { fd: number; tmpPath: string } {
  for (let attempt = 0; ; attempt++) {
    const tmpPath = join(dir, `${prefix}${randomBytes(6).toString('hex')}.tmp`)
    try {
      return { fd: fs.openSync(tmpPath, 'wx', FILE_MODE), tmpPath }
    } catch (error) {
      if (attempt >= 1 || errorCode(error) !== 'EEXIST') throw error
    }
  }
}

function commitExclusive(fs: AtomicFs, tmpPath: string, target: string, data: string): void {
  try {
    fs.linkSync(tmpPath, target)
    return
  } catch (error) {
    if (!LINK_UNSUPPORTED_CODES.has(errorCode(error) ?? '')) throw error
  }

  const fd = fs.openSync(target, 'wx', FILE_MODE)
  try {
    writeAndClose(fs, fd, data)
    fs.chmodSync(target, FILE_MODE)
  } catch (error) {
    // We exclusively created `target`, so a partial file there is ours to remove.
    unlinkIfPresent(fs, target)
    throw error
  }
}

export function writeFileAtomicOwnerOnly(
  target: string,
  data: string,
  options: AtomicWriteOptions,
  fs: AtomicFs = nodeFs
): void {
  const { fd, tmpPath } = openTemp(fs, dirname(target), options.tempPrefix)
  try {
    writeAndClose(fs, fd, data)
    fs.chmodSync(tmpPath, FILE_MODE)
    if (options.exclusive) {
      commitExclusive(fs, tmpPath, target, data)
    } else {
      fs.renameSync(tmpPath, target)
    }
  } finally {
    unlinkIfPresent(fs, tmpPath)
  }
}
