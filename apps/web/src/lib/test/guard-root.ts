// Story 68.9 AC-2: the one place every PV web guard finds the tree it scans and the pack entries it
// merges. PV's own run (no PV_GUARD_APP_ROOT) scans the `src` directory this file sits in, exactly
// as the guards did before; a composed run (`pv-verify`) points the variable at the composed app
// root, so the same rules scan `src/lib/_cm/**` and `src/lib/server/_cm/**` as ordinary source.
//
// The rules here are symmetric: nothing in this file is keyed on who wrote a file. The only path
// knowledge is the lock's removal records, so a PV file a pack removed is not reported missing.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export const GUARD_ROOT_ENV = 'PV_GUARD_APP_ROOT'
export const GUARD_ENTRIES_PATH = 'src/lib/composition/guard-entries.generated.json'
const GENERATED_PARAGLIDE = 'src/lib/paraglide'
export const LOCK_PATH = 'composition.lock.json'
export const SCAN_FAILURE_HINT = 'scan root contains no source files: wrong PV_GUARD_APP_ROOT?'

export interface GuardSource {
  /** App-relative, forward-slash: `src/lib/x.ts`. */
  path: string
  abs: string
}

export interface StorageEntry {
  file: string
  keys: string[]
  reason: string
}

// Spelled in pieces: the guards scan this file like any other source file.
export type StorageApi = `${'session' | 'local'}Storage`

export interface GuardEntries {
  browserStorage: Record<StorageApi, StorageEntry[]> & { release: string[] }
  internalApiConsumers: { add: string[]; release: string[] }
  routeClassifications: { method: string; url: string; class: string; reason: string }[]
  externalHrefs: { allow: { file: string; href: string; reason: string }[] }
}

/** The app root: `PV_GUARD_APP_ROOT` when set, else the directory above this `src`. */
export function guardAppRoot(): string {
  const fromEnv = process.env.PV_GUARD_APP_ROOT
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return resolve(import.meta.dirname, '../../..')
}

export function guardSourceRoot(): string {
  return join(guardAppRoot(), 'src')
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Every file under `<app>/src` whose name matches `pattern`, minus the generated paraglide
 * output (not hand-written source) and `*.test.ts`. Sorted, so counts and failures are stable. */
export function guardSources(pattern: RegExp, appRoot: string = guardAppRoot()): GuardSource[] {
  const found: GuardSource[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const abs = join(dir, entry)
      // Only the generated output is skipped, by its exact path: a directory that merely carries
      // the name elsewhere (for example a nested copy) is ordinary source.
      if (toPosix(relative(appRoot, abs)) === GENERATED_PARAGLIDE) continue
      if (statSync(abs).isDirectory()) walk(abs)
      else if (pattern.test(entry) && !/\.test\.ts$/.test(entry)) {
        found.push({ path: toPosix(relative(appRoot, abs)), abs })
      }
    }
  }
  const root = join(appRoot, 'src')
  if (existsSync(root)) walk(root)
  return found
}

export function readGuardSource(source: GuardSource): string {
  return readFileSync(source.abs, 'utf-8')
}

/** Throws unless the scan saw source files and PV's own sentinel files exist in the app root (a PV
 * file may be absent only when the lock records its removal). A guard that scanned nothing, or a
 * root that is not an app, proves nothing. */
export function assertNotVacuous(sources: readonly GuardSource[], appRoot = guardAppRoot()): void {
  if (sources.length === 0) throw new Error(SCAN_FAILURE_HINT)
  const removed = removedFiles(appRoot)
  const missing = ['src/hooks.server.ts', 'src/routes/+layout.svelte'].filter(
    (sentinel) => !existsSync(join(appRoot, sentinel)) && !removed.has(sentinel)
  )
  if (missing.length > 0) {
    throw new Error(`${SCAN_FAILURE_HINT} (PV sentinel files not found: ${missing.join(', ')})`)
  }
}

interface LockShape {
  removals?: { path: string; files?: string[] }[]
  guardEntries?: Record<string, string>
}

function readLock(appRoot: string): LockShape | null {
  const path = join(appRoot, LOCK_PATH)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LockShape
  } catch {
    return null
  }
}

/** Files (and route-removal ids) the lock records as removed. */
export function removedFiles(appRoot: string = guardAppRoot()): Set<string> {
  const removed = new Set<string>()
  for (const removal of readLock(appRoot)?.removals ?? []) {
    removed.add(removal.path)
    for (const file of removal.files ?? []) removed.add(file)
  }
  return removed
}

const EMPTY_ENTRIES: GuardEntries = {
  browserStorage: {
    [`${'session'}Storage`]: [],
    [`${'local'}Storage`]: [],
    release: [],
  } as GuardEntries['browserStorage'],
  internalApiConsumers: { add: [], release: [] },
  routeClassifications: [],
  externalHrefs: { allow: [] },
}

/** Keys sorted at every depth, so the same data always hashes the same (the kit does the same). */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, sort(entry)])
      )
    }
    return input
  }
  return JSON.stringify(sort(value))
}

export function sectionHash(section: unknown): string {
  return createHash('sha256').update(canonicalJson(section)).digest('hex')
}

/** The merged pack entries `pv-compose` generated into the app (PV commits all sections empty). */
export function readGuardEntries(appRoot: string = guardAppRoot()): GuardEntries {
  const path = join(appRoot, GUARD_ENTRIES_PATH)
  if (!existsSync(path)) return EMPTY_ENTRIES
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GuardEntries>
  return {
    browserStorage: { ...EMPTY_ENTRIES.browserStorage, ...raw.browserStorage },
    internalApiConsumers: { ...EMPTY_ENTRIES.internalApiConsumers, ...raw.internalApiConsumers },
    routeClassifications: raw.routeClassifications ?? [],
    externalHrefs: { ...EMPTY_ENTRIES.externalHrefs, ...raw.externalHrefs },
  }
}

/** A hand-edited generated file (an exemption added without going through the manifest) differs
 * from the hashes the lock recorded. Null when consistent, or when there is no lock to compare. */
export function entriesTamperProblem(appRoot: string = guardAppRoot()): string | null {
  const recorded = readLock(appRoot)?.guardEntries
  if (recorded === undefined) return null
  const path = join(appRoot, GUARD_ENTRIES_PATH)
  const raw = new Map(
    Object.entries(
      (existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}) as Record<string, unknown>
    )
  )
  const recordedHashes = new Map(Object.entries(recorded))
  const sections = new Set([
    ...recordedHashes.keys(),
    ...[...raw.keys()].filter((k) => k !== '_generated'),
  ])
  const differing = [...sections]
    .sort()
    .filter((section) => sectionHash(raw.get(section) ?? null) !== recordedHashes.get(section))
  return differing.length === 0
    ? null
    : `generated guard entries differ from composition.lock.json (${differing.join(', ')}); re-run pv-compose`
}
