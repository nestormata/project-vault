// The one place in @project-vault/crypto that touches the file system with a computed path.
//
// Story 43-26 (Nestor's decision of 2026-10-04, DW-444): `security/detect-non-literal-fs-filename`
// is purely syntactic and the repo carries no inline disables of it. This module is the
// lint-exempt seam (pinned in `FS_ACCESS_MODULES`, enforced by scripts/check-fs-filename-policy.ts).
import { existsSync } from 'node:fs'

/**
 * Whether a path exists.
 * Reason: the only caller probes the backup worker's compiled sibling file, a fixed
 * module-relative path (`new URL('./backup-worker.js', import.meta.url)`), never user input.
 */
export function pathExists(path: string): boolean {
  return existsSync(path)
}
