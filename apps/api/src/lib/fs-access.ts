// The one place in apps/api production source that touches the file system with a computed path.
//
// Story 43-26 (Nestor's decision of 2026-10-04, DW-444): `security/detect-non-literal-fs-filename`
// is purely syntactic, so each of these calls would warn, and the repo has no inline disables of
// the rule. This module is the lint-exempt seam (pinned in `FS_ACCESS_MODULES`, enforced by
// scripts/check-fs-filename-policy.ts) and each function states why its path is trusted. Callers
// keep their own validation (for key files: containment in `VAULT_KEY_DIR`, lstat regular-file
// check, `O_NOFOLLOW`); this module adds none and removes none.
import { closeSync, constants, lstatSync, openSync, type Stats } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'

/**
 * Creates a directory and its missing parents.
 * Reason: the backup directory is operator-configured (`BACKUP_STORAGE_PATH` /
 * `BACKUP_S3_STAGING_PATH`), never request input.
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * Writes a file.
 * Reason: a generated `.tmp-<uuid>-<name>` inside the operator-configured backup directory.
 */
export async function writeFileAt(path: string, data: Buffer): Promise<void> {
  await writeFile(path, data)
}

/**
 * Renames a file (the atomic publish step of a backup write).
 * Reason: both ends are inside the operator-configured backup directory.
 */
export async function renameAt(from: string, to: string): Promise<void> {
  await rename(from, to)
}

/**
 * Reads a file.
 * Reason: a backup file name joined onto the operator-configured backup directory.
 */
export async function readFileAt(path: string): Promise<Buffer> {
  return readFile(path)
}

/**
 * Removes a file; a missing file is not an error.
 * Reason: a backup file name joined onto the operator-configured backup directory.
 */
export async function removeFileAt(path: string): Promise<void> {
  await rm(path, { force: true })
}

/**
 * Deletes one file.
 * Reason: an entry from a listing of the operator-configured staging directory.
 */
export async function unlinkAt(path: string): Promise<void> {
  await unlink(path)
}

/**
 * Lists entry names of a directory.
 * Reason: the operator-configured staging directory (`BACKUP_S3_STAGING_PATH` or its os.tmpdir() default).
 */
export async function listNamesAt(path: string): Promise<string[]> {
  return readdir(path)
}

/**
 * Stats a path.
 * Reason: an entry from a listing of the operator-configured staging directory.
 */
export async function statAt(path: string): Promise<Stats> {
  return stat(path)
}

/**
 * lstat (does not follow a final symlink) for the key-file regular-file check.
 * Reason: the caller has already resolved the path and constrained it to `VAULT_KEY_DIR`.
 */
export function lstatNoFollow(path: string): Stats {
  return lstatSync(path)
}

/**
 * Opens a validated key file read-only without following a final symlink (`O_NOFOLLOW`).
 * Reason: the caller has constrained the path to `VAULT_KEY_DIR` and verified it is a regular file.
 */
export function openReadNoFollow(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
}

/** Closes a descriptor from `openReadNoFollow`.
 * Reason: takes a descriptor, not a path; listed here so key-service has one fs seam. */
export function closeDescriptor(fd: number): void {
  closeSync(fd)
}
