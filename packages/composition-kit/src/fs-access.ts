// The one place in the shipped kit that touches the file system with a computed path.
//
// Story 43-26 (Nestor's decision of 2026-10-04, DW-444): `security/detect-non-literal-fs-filename`
// is purely syntactic, so every kit file access would warn. The kit has no inline disables; this
// module is the lint-exempt seam (pinned in `FS_ACCESS_MODULES`, enforced by
// scripts/check-fs-filename-policy.ts) and every function states why its path is trusted.
//
// Common reason for all of them: the kit is a build-time composer run by the operator or CI over
// directories the operator names on the command line (app root, host dir, pack dir) or derives
// from those (relative paths read from the manifest, the lock or a directory listing, joined onto
// a root and checked for containment by `paths.ts` / `overlay.ts` before use). No path comes from
// a network request or from end-user input at runtime.
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
  type ReadStream,
  type Stats,
} from 'node:fs'

/**
 * Reads a UTF-8 text file.
 * Reason: `path` is an operator-named root joined with a contained relative path (manifest, lock,
 * pack or host file); the kit never reads a path supplied by an end user.
 */
export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Reads a file as bytes (hashing, byte-for-byte comparison, copying pack content).
 * Reason: same operator-named, containment-checked roots as `readText`.
 */
export function readBytes(path: string): Buffer {
  return readFileSync(path)
}

/**
 * Whether a path exists.
 * Reason: probes only inside operator-named roots (optional manifest, lock, config and pack files).
 */
export function pathExists(path: string): boolean {
  return existsSync(path)
}

/**
 * Writes a file (optionally with a creation mode, used for 0600 temp files and 0644 locks).
 * Reason: `path` is inside the operator-named app root or the kit's own scratch directory, never
 * outside it (apply.ts checks the real path stays under the app root first).
 */
export function writeFile(
  path: string,
  data: string | Uint8Array,
  options?: { mode?: number }
): void {
  writeFileSync(path, data, options)
}

/**
 * Creates a file that must not exist yet and writes `text` into it (advisory run lock).
 * Reason: `path` is the kit's lock file inside the operator-named lock directory; `wx` makes a
 * second writer fail instead of overwriting.
 */
export function writeExclusive(path: string, text: string): void {
  writeFileSync(path, text, { flag: 'wx' })
}

/**
 * Creates a directory and its missing parents.
 * Reason: inside the operator-named app root, host dir or the kit's scratch directory.
 */
export function makeDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/**
 * Creates a uniquely named temporary directory next to `prefix`.
 * Reason: `prefix` is the operator-named app root (or the OS temp dir) plus a fixed kit marker.
 */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(prefix, { encoding: 'utf8' })
}

/**
 * Removes a file or directory tree; a missing path is not an error.
 * Reason: only paths the kit created or owns (staging dirs, temp files, files recorded in its own
 * lock inside the app root); apply.ts refuses a root that is `/` or the home directory first.
 */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/**
 * Renames a path (atomic swap of a staged file or directory).
 * Reason: both ends are inside the same operator-named app root or scratch directory.
 */
export function renamePath(from: string, to: string): void {
  renameSync(from, to)
}

/**
 * Copies one file.
 * Reason: source is a pack or host file named by the operator's manifest, target is inside the
 * app root or scratch directory.
 */
export function copyFile(from: string, to: string): void {
  copyFileSync(from, to)
}

/**
 * Resolves a path through symlinks (containment and identity checks).
 * Reason: it is only used to compare an operator-named path with its root, never to open it.
 */
export function realPath(path: string): string {
  return realpathSync(path)
}

/**
 * Stats a path, following symlinks.
 * Reason: operator-named roots and files inside them.
 */
export function statPath(path: string): Stats {
  return statSync(path)
}

/**
 * Stats a path without following a final symlink (refuses symlinked output directories).
 * Reason: operator-named roots and files inside them.
 */
export function lstatPath(path: string): Stats {
  return lstatSync(path)
}

/**
 * Lists a directory with entry types.
 * Reason: walks an operator-named tree (pack, host, app root); the listing's own names are only
 * joined back onto that root.
 */
export function listDir(path: string): Dirent[] {
  return readdirSync(path, { withFileTypes: true })
}

/**
 * Reads a symlink's target.
 * Reason: the link is inside an operator-named tree being snapshotted; the target is recorded,
 * never followed.
 */
export function readLink(path: string): string {
  return readlinkSync(path)
}

/**
 * Opens a read stream (streaming content hash for large files).
 * Reason: same operator-named, containment-checked roots as `readBytes`.
 */
export function readStream(path: string): ReadStream {
  return createReadStream(path)
}
