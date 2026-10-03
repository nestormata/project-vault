import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unifiedDiff } from './diff.js'
import { compareCodeUnits } from './paths.js'
import { sortKeys } from './sort-keys.js'
import type { InjectionPointRecord } from './registry.js'
import type { AdditionRecord, OverrideRecord, RemovalRecord, ReplacementRecord } from './overlay.js'
import type { Relocated } from './materialize.js'
import type { LockInjection } from './injection.js'
import type { CompatibilityTuple } from './types.js'
import type { ProtectedPathsRecord } from './protected-paths.js'
import type { ApiRouteOverrideLock } from './module-pack.js'

/** Story 68.14: 2. `apiRouteOverrides` became an array of `{ method, url, mode, replaceSecurity }`
 * objects (it was always `[]` in version 1). A version 1 lock is still read; recomposing rewrites
 * it as version 2, and `--check` reports the version difference instead of a diff. */
export const LOCKFILE_VERSION = 2
export const SCHEMA_PATH = 'packages/composition-kit/schema/composition.lock.schema.json'

/** Where each manifest contribution landed in the composed tree (what later stories read). */
export interface Contributions {
  hooks: Record<string, string>
  nav: string | null
  theme: string | null
  /** Story 68.6: `derived` lists the CM `(app)` routes the composer protects. A lock written
   * before 68.6 has no `derived` and is read as `derived: []` (additive, no version bump). */
  protectedPaths: ProtectedPathsRecord | null
}

export interface CompositionLock {
  lockfileVersion: number
  compatibility: CompatibilityTuple
  overrides: OverrideRecord[]
  additions: AdditionRecord[]
  removals: RemovalRecord[]
  replacements: Omit<ReplacementRecord, 'hostPath'>[]
  materialized: { path: string; source: string; cmSha256: string }[]
  contributions: Contributions
  excludedPvTests: string[]
  injectionPointsUsed: InjectionPointRecord[]
  /** Story 68.4: every contribution, composed paths, in point and `order` order. Absent in locks
   * written before it existed (read as none). */
  injections?: LockInjection[]
  navIdsReferenced: { id: string; operative: boolean }[]
  /** Story 68.7: the nav ids the pack inserts. Absent in older locks (read as none). */
  navIdsDeclared?: string[]
  /** Story 68.7 (informational): the web-host nav ids this lock was written against, so the next
   * compose can name the ones that are new (inherited). Absent when the host has no nav delta. */
  navIdsHost?: string[]
  /** Story 68.14: the module pack's `apiRoutes.override` table, sorted by `METHOD url`. */
  apiRouteOverrides: ApiRouteOverrideLock[]
  notes: string[]
}

/** Sections `--check` compares. `notes` and the removed files' hashes are informational. */
const NORMATIVE = [
  'compatibility',
  'overrides',
  'additions',
  'replacements',
  'materialized',
  'contributions',
  'injectionPointsUsed',
  'injections',
  'navIdsReferenced',
  'navIdsDeclared',
  'apiRouteOverrides',
] as const

/** Sections a lock may lack and still be read (they were added after lockfileVersion 1). */
const OPTIONAL_SECTIONS: ReadonlySet<string> = new Set(['injections', 'navIdsDeclared'])

export interface LockInput {
  tuple: CompatibilityTuple
  overrides: OverrideRecord[]
  additions: AdditionRecord[]
  removals: RemovalRecord[]
  replacements: ReplacementRecord[]
  relocated: Relocated[]
  contributions: Contributions
  injectionPointsUsed: InjectionPointRecord[]
  injections: LockInjection[]
  navIdsReferenced: { id: string; operative: boolean }[]
  navIdsDeclared?: string[]
  navIdsHost?: string[]
  apiRouteOverrides: ApiRouteOverrideLock[]
  notes: string[]
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareCodeUnits(key(a), key(b)))
}

export function buildLock(input: LockInput): CompositionLock {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    compatibility: input.tuple,
    overrides: sortBy(input.overrides, (entry) => entry.path),
    additions: sortBy(input.additions, (entry) => entry.path),
    removals: sortBy(input.removals, (entry) => entry.path),
    replacements: sortBy(input.replacements, (entry) => entry.target).map(
      ({ hostPath: _hostPath, ...entry }) => entry
    ),
    materialized: sortBy(
      input.relocated.map((entry) => ({
        path: entry.dest,
        source: entry.source,
        cmSha256: entry.cmSha256,
      })),
      (entry) => entry.path
    ),
    contributions: input.contributions,
    excludedPvTests: [],
    injectionPointsUsed: sortBy(input.injectionPointsUsed, (entry) => entry.name),
    injections: input.injections,
    navIdsReferenced: sortBy(input.navIdsReferenced, (entry) => entry.id),
    ...(input.navIdsDeclared === undefined
      ? {}
      : { navIdsDeclared: [...input.navIdsDeclared].sort(compareCodeUnits) }),
    ...(input.navIdsHost === undefined
      ? {}
      : { navIdsHost: [...input.navIdsHost].sort(compareCodeUnits) }),
    apiRouteOverrides: sortBy(input.apiRouteOverrides, (entry) => `${entry.method} ${entry.url}`),
    notes: [...new Set(input.notes)].sort(compareCodeUnits),
  }
}

/** Deterministic text: sorted keys, two-space indent, trailing newline, no timestamps, no absolute
 * paths, no hostnames. The same input yields identical bytes on any machine. */
export function serializeLock(lock: CompositionLock): string {
  return `${JSON.stringify(sortKeys(lock), null, 2)}\n`
}

/** Structural validation of a lock read from disk. */
export function parseLock(
  text: string,
  label: string
): { lock?: CompositionLock; problem?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { problem: `${label} is not valid JSON (schema: ${SCHEMA_PATH})` }
  }
  const record = raw as Record<string, unknown> | null
  const version = record?.lockfileVersion
  if (typeof version !== 'number') {
    return { problem: `${label} has no lockfileVersion (schema: ${SCHEMA_PATH})` }
  }
  if (version > LOCKFILE_VERSION) {
    return {
      problem: `${label} was written by a newer kit (lockfileVersion ${version}); upgrade @project-vault/composition-kit`,
    }
  }
  const missing = [...NORMATIVE, 'removals', 'notes'].filter(
    (key) => !OPTIONAL_SECTIONS.has(key) && !(key in (record ?? {}))
  )
  if (missing.length > 0) {
    return { problem: `${label} is missing ${missing.join(', ')} (schema: ${SCHEMA_PATH})` }
  }
  return { lock: withV1Overrides(withDerivedDefault(record as unknown as CompositionLock)) }
}

/** A version 1 lock always had `apiRouteOverrides: []`; read it as the empty table. */
function withV1Overrides(lock: CompositionLock): CompositionLock {
  return lock.lockfileVersion === 1 ? { ...lock, apiRouteOverrides: [] } : lock
}

/** Locks written before Story 68.6 have no `contributions.protectedPaths.derived`. */
function withDerivedDefault(lock: CompositionLock): CompositionLock {
  const paths = lock.contributions?.protectedPaths as Partial<ProtectedPathsRecord> | null
  if (paths === null || paths === undefined || Array.isArray(paths.derived)) return lock
  return {
    ...lock,
    contributions: {
      ...lock.contributions,
      protectedPaths: { add: paths.add ?? [], remove: paths.remove ?? [], derived: [] },
    },
  }
}

export function readLock(path: string): { lock?: CompositionLock; problem?: string } | null {
  if (!existsSync(path)) return null
  return parseLock(readFileSync(path, 'utf8'), path)
}

/** The normative part of a lock, as text, for `--check`. */
function normativeText(lock: CompositionLock): string {
  const normative = new Map(
    Object.entries({
      ...lock,
      injections: lock.injections ?? [],
      navIdsDeclared: lock.navIdsDeclared ?? [],
    }).filter(([key]) => (NORMATIVE as readonly string[]).includes(key))
  )
  const picked = {
    ...Object.fromEntries(normative),
    lockfileVersion: lock.lockfileVersion,
    removals: lock.removals.map((entry) => entry.path),
  }
  return `${JSON.stringify(sortKeys(picked), null, 2)}\n`
}

/** The normative sections whose content differs between two locks, in lock order (`--check` names
 * them so the drifted section is visible even when the diff hunk shows only a nested value). */
export function driftedSections(
  committed: CompositionLock,
  regenerated: CompositionLock
): string[] {
  const view = (lock: CompositionLock) =>
    new Map(
      Object.entries({
        ...lock,
        injections: lock.injections ?? [],
        removals: lock.removals.map((entry) => entry.path),
      })
    )
  const left = view(committed)
  const right = view(regenerated)
  return [...NORMATIVE, 'removals', 'lockfileVersion'].filter(
    (key) => JSON.stringify(sortKeys(left.get(key))) !== JSON.stringify(sortKeys(right.get(key)))
  )
}

/** `--check`: empty when the committed lock equals the regenerated one in the normative sections. */
export function lockDifference(committed: CompositionLock, regenerated: CompositionLock): string {
  return unifiedDiff(
    normativeText(committed),
    normativeText(regenerated),
    'committed composition.lock.json',
    'regenerated lock'
  )
}

/** Atomic write: a temp file in the same directory, then rename. */
export function writeFileAtomic(path: string, content: string): void {
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temp, content, { mode: 0o644 })
  renameSync(temp, path)
}
