// The one place in the shipped web-host guards that touches the file system with a computed path.
//
// Story 43-26 (Nestor's decision of 2026-10-04, DW-511): `security/detect-non-literal-fs-filename`
// is purely syntactic, so every guard file read would warn, and these files ship in the published
// package, so they carry no inline disable. This module is the lint-exempt seam (pinned in
// `FS_ACCESS_MODULES`, enforced by scripts/check-fs-filename-policy.ts) and each function states
// why its path is trusted. It imports only `node:` modules, so the compiled copy runs from a
// published package like the guards that use it.
//
// Common reason: a guard scans the source root its caller hands it (`pv-verify` passes the composed
// app, the repository scripts pass the checkout), and walks below that root; no path comes from a
// network request or from end-user input.
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs'

/**
 * Reads a UTF-8 source file.
 * Reason: `path` is a file found by walking the scan root the caller named.
 */
export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Lists the entry names of a directory.
 * Reason: `path` is the scan root or a directory found below it; an unreadable root throws on
 * purpose so a guard cannot pass by scanning nothing.
 */
export function listNames(path: string): string[] {
  return readdirSync(path)
}

/**
 * Stats a path, following symlinks.
 * Reason: `path` is an entry found below the scan root; a dangling link throws and the walker skips it.
 */
export function statPath(path: string): Stats {
  return statSync(path)
}
