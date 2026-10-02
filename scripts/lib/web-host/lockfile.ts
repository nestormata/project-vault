// Story 68.2 AC-2: exact versions for the web-host manifest come from pnpm-lock.yaml, never from
// package.json ranges. pnpm `overrides` never reach a consumer, so the consumer must be told the
// version PV actually builds and tests with.
import semver from 'semver'
import { parseYaml } from '../yaml.js'

interface LockDependency {
  specifier: string
  version: string
}

interface LockImporter {
  dependencies?: Record<string, LockDependency>
  devDependencies?: Record<string, LockDependency>
  optionalDependencies?: Record<string, LockDependency>
}

export interface Lockfile {
  importers: Record<string, LockImporter>
}

export interface LockedDependency {
  /** The range package.json declared, as pnpm recorded it. */
  specifier: string
  /** The exact resolved version, peer suffix stripped (`5.57.1(@x/y@1)` -> `5.57.1`). */
  version: string
  /** For a workspace link (`link:../../packages/x`), the relative link target. */
  link?: string
}

export function parseLockfile(text: string): Lockfile {
  const parsed = parseYaml(text) as Partial<Lockfile> | null
  if (!parsed?.importers) throw new Error('pnpm-lock.yaml has no importers block')
  return { importers: parsed.importers }
}

/** `5.57.1(@typescript-eslint/types@8.70.1)` -> `5.57.1`. */
export function stripPeerSuffix(version: string): string {
  const open = version.indexOf('(')
  return open === -1 ? version : version.slice(0, open)
}

/** Every direct dependency an importer (`apps/web`) resolved, by name. */
export function importerDependencies(
  lockfile: Lockfile,
  importer: string
): Map<string, LockedDependency> {
  const block = Object.entries(lockfile.importers).find(([key]) => key === importer)?.[1]
  if (block === undefined) throw new Error(`pnpm-lock.yaml has no importer ${importer}`)
  const all = {
    ...block.optionalDependencies,
    ...block.devDependencies,
    ...block.dependencies,
  }
  return new Map(
    Object.entries(all).map(([name, entry]): [string, LockedDependency] => {
      const version = stripPeerSuffix(entry.version)
      return version.startsWith('link:')
        ? [name, { specifier: entry.specifier, version, link: version.slice('link:'.length) }]
        : [name, { specifier: entry.specifier, version }]
    })
  )
}

/** Drift between what a manifest declares and what the lockfile recorded/resolved for it: a range
 * that was changed without regenerating the lockfile, or a resolved version outside the range. */
export function findDrift(
  declared: Record<string, string>,
  locked: Map<string, LockedDependency>
): string[] {
  return Object.entries(declared).flatMap(([name, range]): string[] => {
    const entry = locked.get(name)
    if (entry === undefined) return [`drift: ${name} declared ${range}, missing from the lockfile`]
    if (entry.link !== undefined) {
      return entry.specifier === range
        ? []
        : [`drift: ${name} declared ${range}, lockfile ${entry.specifier}`]
    }
    if (entry.specifier !== range || !semver.satisfies(entry.version, range)) {
      return [`drift: ${name} declared ${range}, lockfile ${entry.version}`]
    }
    return []
  })
}

/** Merges several importers' views of one package into one exact version, failing when two
 * importers resolved different base versions (the consumer can install only one). */
export function singleVersion(name: string, versions: string[]): string {
  const distinct = [...new Set(versions)]
  if (distinct.length === 0) throw new Error(`no lockfile version for ${name}`)
  if (distinct.length > 1) {
    throw new Error(
      `${name} resolves to several versions in pnpm-lock.yaml: ${distinct.join(', ')}`
    )
  }
  return distinct[0] as string
}

/** An exact semver version (prerelease allowed, no range, tag, protocol or build metadata). */
export function isExactVersion(value: string): boolean {
  return semver.valid(value) === value && !value.includes('+')
}
