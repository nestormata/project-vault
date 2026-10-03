import type { AppOptions } from '../app.js'

/**
 * Story 68.14 — pieces shared by the one-shot tooling scripts that boot `createApp()` with an
 * extension but without a database: `generate-spec --extension` and `route-audit:runtime`.
 */

/** The loader's injection seams that touch the DB, stubbed: no org to enumerate, no audit row. */
export const DB_FREE_LOADER_DEPS: NonNullable<NonNullable<AppOptions['extension']>['loaderDeps']> =
  {
    listOrgIds: () => Promise.resolve([]),
    auditWriter: () => Promise.resolve(undefined),
  }

// A bare npm package specifier: `name` or `@scope/name`, each segment a lowercase npm name part.
// Never a path, URL or version.
const PACKAGE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

export function isBarePackageSpecifier(value: string): boolean {
  const scoped = value.startsWith('@')
  const segments = scoped ? value.slice(1).split('/') : [value]
  return (
    segments.length === (scoped ? 2 : 1) &&
    segments.every((segment) => PACKAGE_SEGMENT_PATTERN.test(segment))
  )
}

/** Splits `argv` into `[flag, value]` pairs; a trailing flag has an undefined value. */
export function flagPairs(argv: readonly string[]): Array<[string, string | undefined]> {
  return Array.from({ length: Math.ceil(argv.length / 2) }, (_unused, pair) => {
    const [flag, value] = argv.slice(pair * 2, pair * 2 + 2)
    return [flag ?? '', value]
  })
}
