// The one place in the root `scripts/` guards that touches the file system with a computed path.
//
// Story 43-26 (Nestor's decision of 2026-10-04, DW-444): `security/detect-non-literal-fs-filename`
// is purely syntactic and the repo carries no inline disables of it. This module is the
// lint-exempt seam (pinned in `FS_ACCESS_MODULES`, enforced by scripts/check-fs-filename-policy.ts).
//
// Common reason: these are repository guard scripts run by a developer or by CI over a checkout.
// Their roots are the current repository or a root a test passes in, and file names are joined
// from fixed repo-relative constants or from listings of those roots; no path comes from a
// network request or from end-user input.
import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs'

/**
 * Reads a UTF-8 text file.
 * Reason: a repo-relative file under the checked root (tests pass a fixture root, CI passes cwd).
 */
export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * Whether a path exists.
 * Reason: probes a repo-relative file under the checked root.
 */
export function pathExists(path: string): boolean {
  return existsSync(path)
}

/**
 * Lists the entry names of a directory.
 * Reason: a directory under the checked root (workspace package directories, scanned folders).
 */
export function listNames(path: string): string[] {
  return readdirSync(path)
}

/**
 * Stats a path, following symlinks.
 * Reason: an entry found under the checked root.
 */
export function statPath(path: string): Stats {
  return statSync(path)
}
