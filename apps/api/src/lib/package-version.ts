import { readFileSync } from 'node:fs'

/**
 * Story 9.3 AC-19: reads `version` from a `package.json` file at generation/registration time,
 * so the OpenAPI spec's `info.version` (and any other consumer) reflects the real, current
 * package version instead of a permanently hardcoded literal that silently drifts out of sync.
 */
export function readPackageVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string }
  return pkg.version
}
