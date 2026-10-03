// Story 68.9 AC-3: the guard-entries file a UI pack authors (manifest field `guards`), its integrity
// validation, the mapping of pack-relative paths to composed paths, and the generated JSON module
// PV's web guards read (`src/lib/composition/guard-entries.generated.json`).
//
// Every check here is INTEGRITY ONLY (the entry is well formed, names a real composed file, collides
// with nothing by accident). No entry limits what CM may do: an entry only adds or releases a reviewed
// carve-out of a PV guard, by exact path, and guards enforce the same rules on every file.
import { createHash } from 'node:crypto'
import { compareCodeUnits, findCaseCollisions, normalizePackPath } from './paths.js'
import { sortKeys } from './sort-keys.js'

export interface StorageEntryInput {
  file: string
  keys: string[]
  reason: string
}

/** The entry shape of the runtime route audit's classification file (`route-audit.ts`, Story 68-14). */
export interface RouteClassificationInput {
  /** `METHOD /full/url` (the audit's route key), or `OPTIONS *`. */
  route: string
  reason: string
  securityOwner?: string
  compensatingControls?: string[]
  expiresAfterStory?: string | null
  revisitBy?: string
  temporary?: boolean
}

export interface ExternalHrefInput {
  file: string
  href: string
  reason: string
}

export interface GuardEntriesInput {
  browserStorage?: {
    sessionStorage?: StorageEntryInput[]
    localStorage?: StorageEntryInput[]
    release?: string[]
  }
  internalApiConsumers?: { add?: string[]; release?: string[] }
  routeClassifications?: RouteClassificationInput[]
  externalHrefs?: { allow?: ExternalHrefInput[] }
}

/** Identity at runtime, typed at compile time (the same shape as `defineUiPack`). */
export function defineGuardEntries(entries: GuardEntriesInput): GuardEntriesInput {
  return entries
}

/** The merged result, composed paths, every section present (what the generated file holds). */
export interface MergedGuardEntries {
  browserStorage: {
    sessionStorage: StorageEntryInput[]
    localStorage: StorageEntryInput[]
    release: string[]
  }
  internalApiConsumers: { add: string[]; release: string[] }
  routeClassifications: RouteClassificationInput[]
  externalHrefs: { allow: ExternalHrefInput[] }
}

export const GUARD_ENTRIES_PATH = 'src/lib/composition/guard-entries.generated.json'
const GENERATED_NOTE =
  "pv-compose writes this file from the UI pack's guards entries; PV commits it with every section empty. Do not edit by hand."
const KNOWN_SECTIONS = new Set([
  'browserStorage',
  'internalApiConsumers',
  'routeClassifications',
  'externalHrefs',
])
// A key is written into a generated source check; keep it free of anything that ends a string.
const UNSAFE_KEY = /["'`\\\n\r]/

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ready(section: string, snippet: string): string {
  return (
    ` Fix: add ${section}: ${snippet} (entries are reviewed under PV's rules; the alternative is ` +
    'to fix the code).'
  )
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Whether a value survives a JSON round trip unchanged (data only: no functions, no cycles). */
function isPlainData(value: unknown): boolean {
  try {
    return JSON.stringify(value) === JSON.stringify(JSON.parse(JSON.stringify(value)))
  } catch {
    return false
  }
}

function containsFunction(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (Array.isArray(value)) return value.some(containsFunction)
  return isRecord(value) && Object.values(value).some(containsFunction)
}

function pathProblem(label: string, path: unknown): string | null {
  if (!nonEmptyString(path)) return `${label} must be a non-empty string`
  const normalized = normalizePackPath(path)
  if (normalized === null) {
    return `${label} "${path}" must be a relative path inside the UI pack (no "..", no absolute path, no backslashes)`
  }
  return null
}

function keyProblems(label: string, keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(nonEmptyString)) {
    return [`${label}.keys must be a non-empty array of non-empty strings`]
  }
  return keys
    .filter((key: string) => UNSAFE_KEY.test(key))
    .map(
      (key: string) =>
        `${label}.keys: ${JSON.stringify(key)} holds a quote, backtick, backslash or newline`
    )
}

const STORAGE_SNIPPET =
  "[{ file: '<path>', keys: ['<key>'], reason: '<why this is non-sensitive>' }]"

function storageEntryProblems(api: string, entry: unknown, index: number): string[] {
  const label = `browserStorage.${api}[${index}]`
  if (!isRecord(entry)) return [`${label} must be an object`]
  const file = pathProblem(`${label}.file`, entry.file)
  const hint = ready(`browserStorage.${api}`, STORAGE_SNIPPET)
  const reasonProblem = nonEmptyString(entry.reason) ? [] : [`${label} has no reason.${hint}`]
  return [...(file === null ? [] : [file]), ...reasonProblem, ...keyProblems(label, entry.keys)]
}

function checkStorage(api: string, value: unknown, problems: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    problems.push(`browserStorage.${api} must be an array`)
    return
  }
  const seen = new Set<string>()
  value.forEach((entry: unknown, index) => {
    problems.push(...storageEntryProblems(api, entry, index))
    const file = isRecord(entry) ? entry.file : undefined
    if (typeof file !== 'string') return
    const identity = normalizePackPath(file) ?? file
    if (seen.has(identity)) {
      problems.push(
        `duplicate guard entry browserStorage.${api}[${index}] for ${identity} (${api})`
      )
    }
    seen.add(identity)
  })
}

function checkStringList(label: string, value: unknown, problems: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array of paths`)
    return
  }
  value.forEach((entry: unknown, index) => {
    const problem = pathProblem(`${label}[${index}]`, entry)
    if (problem !== null) problems.push(problem)
  })
}

// These rules mirror `parseClassifications` in apps/api/src/extensions/api-routes/route-audit.ts
// (the MIT kit cannot import it). scripts/check-composition-kit-route-classifications.test.ts keeps
// the two in step by feeding the same entries to both.
const ROUTE_KEY = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*|\*)$/u
const CLASSIFICATION_KEYS = new Set([
  'route',
  'reason',
  'securityOwner',
  'compensatingControls',
  'expiresAfterStory',
  'revisitBy',
  'temporary',
])
const LEGACY_CLASSIFICATION_KEYS = new Set(['method', 'url', 'class'])

function optionalTextProblem(label: string, name: string, value: unknown): string[] {
  return value === undefined || nonEmptyString(value)
    ? []
    : [`${label}.${name} must be a non-empty string`]
}

function optionalProblems(label: string, entry: Rec): string[] {
  const expires = entry.expiresAfterStory
  const controls = entry.compensatingControls
  return [
    ...optionalTextProblem(label, 'securityOwner', entry.securityOwner),
    ...optionalTextProblem(label, 'revisitBy', entry.revisitBy),
    ...(expires === null ? [] : optionalTextProblem(label, 'expiresAfterStory', expires)),
    ...(controls === undefined || (Array.isArray(controls) && controls.every(nonEmptyString))
      ? []
      : [`${label}.compensatingControls must be an array of non-empty strings`]),
    ...(entry.temporary === undefined || typeof entry.temporary === 'boolean'
      ? []
      : [`${label}.temporary must be a boolean`]),
  ]
}

function unknownFieldProblems(label: string, entry: Rec): string[] {
  const unknown = Object.keys(entry).filter((key) => !CLASSIFICATION_KEYS.has(key))
  if (unknown.length === 0) return []
  const legacy = unknown.some((key) => LEGACY_CLASSIFICATION_KEYS.has(key))
  const hint = legacy
    ? '; use { route: "GET /api/v1/x", reason } (the route audit entry shape)'
    : ''
  const names = unknown.map((key) => '"' + key + '"').join(', ')
  return [`${label} has unknown field ${names}${hint}`]
}

function classificationProblems(label: string, entry: unknown): string[] {
  if (!isRecord(entry)) return [`${label} must be an object`]
  const problems = unknownFieldProblems(label, entry)
  if (!nonEmptyString(entry.route) || !ROUTE_KEY.test(entry.route)) {
    problems.push(
      `${label}.route must be "METHOD /full/url" with one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`
    )
  }
  if (!nonEmptyString(entry.reason)) problems.push(`${label} has no reason`)
  return [...problems, ...optionalProblems(label, entry)]
}

function checkClassifications(value: unknown, problems: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    problems.push('routeClassifications must be an array')
    return
  }
  const seen = new Set<string>()
  value.forEach((entry: unknown, index) => {
    const label = `routeClassifications[${index}]`
    problems.push(...classificationProblems(label, entry))
    const route = isRecord(entry) ? entry.route : undefined
    if (typeof route !== 'string') return
    if (seen.has(route))
      problems.push(`duplicate guard entry ${label}: ${route} is classified twice`)
    seen.add(route)
  })
}

function checkHrefs(value: unknown, problems: string[]): void {
  if (value === undefined) return
  const allow = isRecord(value) ? value.allow : undefined
  if (allow === undefined) return
  if (!Array.isArray(allow)) {
    problems.push('externalHrefs.allow must be an array')
    return
  }
  allow.forEach((entry: unknown, index) => {
    const label = `externalHrefs.allow[${index}]`
    if (!isRecord(entry)) {
      problems.push(`${label} must be an object`)
      return
    }
    const problem = pathProblem(`${label}.file`, entry.file)
    if (problem !== null) problems.push(problem)
    if (!nonEmptyString(entry.href)) problems.push(`${label}.href must be a non-empty string`)
    if (!nonEmptyString(entry.reason)) problems.push(`${label} has no reason`)
  })
}

export interface GuardEntriesValidation {
  entries?: GuardEntriesInput
  problems: string[]
  notes: string[]
}

/** Structural and integrity validation of the loaded guard-entries file. */
export function validateGuardEntries(raw: unknown): GuardEntriesValidation {
  const problems: string[] = []
  const notes: string[] = []
  if (!isRecord(raw)) {
    return {
      problems: ['the guard entries must be an object (export default defineGuardEntries({...}))'],
      notes,
    }
  }
  if (containsFunction(raw) || !isPlainData(raw)) {
    return {
      problems: [
        'the guard entries must be plain data (no functions, classes or cycles): the kit never executes them',
      ],
      notes,
    }
  }
  const storage = raw.browserStorage
  if (storage !== undefined) {
    if (!isRecord(storage)) problems.push('browserStorage must be an object')
    else {
      checkStorage('sessionStorage', storage.sessionStorage, problems)
      checkStorage('localStorage', storage.localStorage, problems)
      checkStringList('browserStorage.release', storage.release, problems)
    }
  }
  const consumers = raw.internalApiConsumers
  if (consumers !== undefined) {
    if (!isRecord(consumers)) problems.push('internalApiConsumers must be an object')
    else {
      checkStringList('internalApiConsumers.add', consumers.add, problems)
      checkStringList('internalApiConsumers.release', consumers.release, problems)
    }
  }
  checkClassifications(raw.routeClassifications, problems)
  checkHrefs(raw.externalHrefs, problems)
  for (const key of Object.keys(raw).filter((entry) => !KNOWN_SECTIONS.has(entry))) {
    notes.push(`unknown guard entries section "${key}" ignored (a newer kit may give it meaning)`)
  }
  return problems.length > 0
    ? { problems, notes }
    : { entries: raw as GuardEntriesInput, problems, notes }
}

export interface MapContext {
  /** Pack-relative path -> composed path, for every file materialized under `src/lib/_cm`. */
  relocated: ReadonlyMap<string, string>
  /** Pack files overlaid in place (additions and overrides): same path in the composed tree. */
  overlayPaths: ReadonlySet<string>
  /** Host paths the pack overrides, replaces or removes (a release may name only these). */
  changedHostPaths: ReadonlySet<string>
}

function composedPath(rel: string, context: MapContext): string | null {
  const path = normalizePackPath(rel)
  if (path === null) return null
  return context.relocated.get(path) ?? (context.overlayPaths.has(path) ? path : null)
}

const bySortKey = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => compareCodeUnits(key(a), key(b)))

function mapStorage(
  api: string,
  entries: readonly StorageEntryInput[],
  context: MapContext,
  problems: string[]
): StorageEntryInput[] {
  const mapped = entries.flatMap((entry, index) => {
    const file = composedPath(entry.file, context)
    if (file === null) {
      problems.push(
        `guard entry browserStorage.${api}[${index}].file "${entry.file}" maps to no composed file (stale carve-out)`
      )
      return []
    }
    return [{ file, keys: [...new Set(entry.keys)].sort(compareCodeUnits), reason: entry.reason }]
  })
  for (const group of findCaseCollisions(mapped.map((entry) => entry.file))) {
    problems.push(`guard entries browserStorage.${api} differ only by case: ${group.join(', ')}`)
  }
  return bySortKey(mapped, (entry) => entry.file)
}

function mapAdds(
  paths: readonly string[],
  context: MapContext,
  label: string,
  problems: string[]
): string[] {
  const mapped = paths.flatMap((path, index) => {
    const file = composedPath(path, context)
    if (file === null) {
      problems.push(
        `guard entry ${label}[${index}] "${path}" maps to no composed file (stale carve-out)`
      )
      return []
    }
    return [file]
  })
  return [...new Set(mapped)].sort(compareCodeUnits)
}

/** A release names a PV file by its host path, and only a file CM overrode, replaced or removed. */
function mapReleases(
  paths: readonly string[],
  context: MapContext,
  label: string,
  problems: string[]
): string[] {
  const released = paths.flatMap((path, index) => {
    const normalized = normalizePackPath(path) ?? path
    if (!context.changedHostPaths.has(normalized)) {
      problems.push(
        `${label}[${index}] "${path}": cannot release an entry for a file CM did not change (override, replace or remove it first)`
      )
      return []
    }
    return [normalized]
  })
  return [...new Set(released)].sort(compareCodeUnits)
}

function mapHrefs(
  allow: readonly ExternalHrefInput[],
  context: MapContext,
  problems: string[]
): ExternalHrefInput[] {
  return bySortKey(allow, (entry) => `${entry.file} ${entry.href}`).flatMap((entry) => {
    const file = composedPath(entry.file, context)
    if (file === null) {
      problems.push(
        `guard entry externalHrefs.allow "${entry.file}" maps to no composed file (stale carve-out)`
      )
      return []
    }
    return [{ ...entry, file }]
  })
}

function mergeStorage(
  storage: GuardEntriesInput['browserStorage'],
  context: MapContext,
  problems: string[]
): MergedGuardEntries['browserStorage'] {
  return {
    sessionStorage: mapStorage('sessionStorage', storage?.sessionStorage ?? [], context, problems),
    localStorage: mapStorage('localStorage', storage?.localStorage ?? [], context, problems),
    release: mapReleases(storage?.release ?? [], context, 'browserStorage.release', problems),
  }
}

function mergeConsumers(
  consumers: GuardEntriesInput['internalApiConsumers'],
  context: MapContext,
  problems: string[]
): MergedGuardEntries['internalApiConsumers'] {
  return {
    add: mapAdds(consumers?.add ?? [], context, 'internalApiConsumers.add', problems),
    release: mapReleases(
      consumers?.release ?? [],
      context,
      'internalApiConsumers.release',
      problems
    ),
  }
}

/** Maps a validated pack file to composed paths and checks it against the composed tree. */
export function mergeGuardEntries(
  entries: GuardEntriesInput | undefined,
  context: MapContext
): { merged: MergedGuardEntries; problems: string[] } {
  const problems: string[] = []
  const merged: MergedGuardEntries = {
    browserStorage: mergeStorage(entries?.browserStorage, context, problems),
    internalApiConsumers: mergeConsumers(entries?.internalApiConsumers, context, problems),
    routeClassifications: bySortKey(entries?.routeClassifications ?? [], (entry) => entry.route),
    externalHrefs: { allow: mapHrefs(entries?.externalHrefs?.allow ?? [], context, problems) },
  }
  return { merged, problems }
}

/** The generated module's text: a marker first, sections sorted, trailing newline. */
export function generatedEntriesText(merged: MergedGuardEntries): string {
  return `${JSON.stringify({ _generated: GENERATED_NOTE, ...(sortKeys(merged) as Rec) }, null, 2)}\n`
}

/** Per-section sha256 over canonical JSON (the web guards recompute the same value). */
export function sectionHashes(file: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(isRecord(file) ? file : {})
      .filter(([key]) => key !== '_generated')
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, section]) => [
        key,
        createHash('sha256')
          .update(JSON.stringify(sortKeys(section)))
          .digest('hex'),
      ])
  )
}
