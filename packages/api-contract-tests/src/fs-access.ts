// The one place in @project-vault/api-contract-tests that touches the file system with a computed path.
//
// Story 43-26 (Nestor's decision of 2026-10-04, DW-444): `security/detect-non-literal-fs-filename`
// is purely syntactic and the repo carries no inline disables of it. This module is the
// lint-exempt seam (pinned in `FS_ACCESS_MODULES`, enforced by scripts/check-fs-filename-policy.ts).
import { readFileSync } from 'node:fs'

/**
 * Reads a UTF-8 text file.
 * Reason: the spec loader defaults to this repository's own generated OpenAPI file and is only
 * ever pointed elsewhere by test fixtures, never by user input.
 */
export function readText(path: string): string {
  return readFileSync(path, 'utf-8')
}
