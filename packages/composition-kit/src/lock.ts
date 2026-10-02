import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unifiedDiff } from './diff.js'
import { compareCodeUnits } from './paths.js'
import type { InjectionPointRecord } from './registry.js'
import type { AdditionRecord, OverrideRecord, RemovalRecord, ReplacementRecord } from './overlay.js'
import type { Relocated } from './materialize.js'
import type { CompatibilityTuple } from './types.js'

export const LOCKFILE_VERSION = 1
export const SCHEMA_PATH = 'packages/composition-kit/schema/composition.lock.schema.json'

/** Where each manifest contribution landed in the composed tree (what later stories read). */
export interface Contributions {
  hooks: Record<string, string>
  nav: string | null
  theme: string | null
  protectedPaths: { add: string[]; remove: string[] } | null
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
  navIdsReferenced: { id: string; operative: boolean }[]
  apiRouteOverrides: string[]
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
  'navIdsReferenced',
  'apiRouteOverrides',
] as const

export interface LockInput {
  tuple: CompatibilityTuple
  overrides: OverrideRecord[]
  additions: AdditionRecord[]
  removals: RemovalRecord[]
  replacements: ReplacementRecord[]
  relocated: Relocated[]
  contributions: Contributions
  injectionPointsUsed: InjectionPointRecord[]
  navIdsReferenced: { id: string; operative: boolean }[]
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
    navIdsReferenced: sortBy(input.navIdsReferenced, (entry) => entry.id),
    apiRouteOverrides: [],
    notes: [...new Set(input.notes)].sort(compareCodeUnits),
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, entry]) => [key, sortKeys(entry)])
    )
  }
  return value
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
  const missing = [...NORMATIVE, 'removals', 'notes'].filter((key) => !(key in (record ?? {})))
  if (missing.length > 0) {
    return { problem: `${label} is missing ${missing.join(', ')} (schema: ${SCHEMA_PATH})` }
  }
  return { lock: record as unknown as CompositionLock }
}

export function readLock(path: string): { lock?: CompositionLock; problem?: string } | null {
  if (!existsSync(path)) return null
  return parseLock(readFileSync(path, 'utf8'), path)
}

/** The normative part of a lock, as text, for `--check`. */
function normativeText(lock: CompositionLock): string {
  const normative = new Map(
    Object.entries(lock).filter(([key]) => (NORMATIVE as readonly string[]).includes(key))
  )
  const picked = {
    ...Object.fromEntries(normative),
    lockfileVersion: lock.lockfileVersion,
    removals: lock.removals.map((entry) => entry.path),
  }
  return `${JSON.stringify(sortKeys(picked), null, 2)}\n`
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
