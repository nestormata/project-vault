import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ObservedRoute } from './route-observer.js'

/**
 * Story 68.14 AC-2 — the pure core of the runtime route audit: strict classification parsing, the
 * merge of PV's table with an extension-supplied one, and the classifier that proves every route
 * on the composed API is `secureRoute`-built or classified.
 *
 * Integrity only: the audit never decides WHICH routes may be public (that is the reviewer's job,
 * under the same rules for PV and extension entries). It only proves that no route escaped
 * review: an unclassified raw route fails, a duplicate key fails, a stale classification fails.
 */

const ALLOWED_ENTRY_KEYS = [
  'route',
  'reason',
  'securityOwner',
  'compensatingControls',
  'expiresAfterStory',
  'revisitBy',
  'temporary',
]
const ROUTE_KEY_PATTERN = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*|\*)$/u

export type ClassificationEntry = {
  route: string
  reason: string
  securityOwner?: string
  compensatingControls?: string[]
  expiresAfterStory?: string | null
  revisitBy?: string
  temporary?: boolean
}

export type ClassificationSource = 'pv' | 'extension'

/** A defect in the classification input (a usage error, exit code 2), never an audit failure. */
export class ClassificationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClassificationInputError'
  }
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClassificationInputError(`${path} must be a non-empty string`)
  }
  return value
}

function assertOptionalFields(entry: UnknownRecord, path: string): void {
  const owner = entry['securityOwner']
  if (owner !== undefined) requireText(owner, `${path}.securityOwner`)
  const revisitBy = entry['revisitBy']
  if (revisitBy !== undefined) requireText(revisitBy, `${path}.revisitBy`)
  const controls = entry['compensatingControls']
  if (controls !== undefined) {
    if (!Array.isArray(controls)) {
      throw new ClassificationInputError(`${path}.compensatingControls must be an array`)
    }
    controls.forEach((control, index) =>
      requireText(control, `${path}.compensatingControls[${index}]`)
    )
  }
  const expires = entry['expiresAfterStory']
  if (expires !== undefined && expires !== null) requireText(expires, `${path}.expiresAfterStory`)
  const temporary = entry['temporary']
  if (temporary !== undefined && typeof temporary !== 'boolean') {
    throw new ClassificationInputError(`${path}.temporary must be a boolean`)
  }
}

function parseEntry(raw: unknown, index: number): ClassificationEntry {
  const path = `classifications[${index}]`
  if (!isRecord(raw)) throw new ClassificationInputError(`${path} must be an object`)
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_ENTRY_KEYS.includes(key)) {
      throw new ClassificationInputError(`${path} has unknown field "${key}"`)
    }
  }
  const route = requireText(raw['route'], `${path}.route`)
  if (!ROUTE_KEY_PATTERN.test(route)) {
    throw new ClassificationInputError(
      `${path}.route must be "METHOD /full/url" with one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`
    )
  }
  requireText(raw['reason'], `${path}.reason`)
  assertOptionalFields(raw, path)
  return raw as unknown as ClassificationEntry
}

/**
 * Parses and strictly validates classification JSON: a top-level array of entries in PV's own
 * entry shape (`route` and `reason` required, the PV table's optional fields allowed, anything
 * else rejected). Duplicate keys fail. Nothing is silently dropped.
 */
export function parseClassifications(text: string): ClassificationEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ClassificationInputError('classifications input is not valid JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new ClassificationInputError('classifications input must be a JSON array of entries')
  }
  const seen = new Set<string>()
  return parsed.map((raw, index) => {
    const entry = parseEntry(raw, index)
    if (seen.has(entry.route)) {
      throw new ClassificationInputError(
        `classifications[${index}] duplicates the route key ${entry.route}`
      )
    }
    seen.add(entry.route)
    return entry
  })
}

/**
 * Reads a classifications file. The path is resolved to an absolute path and must be a regular
 * file (no directory, FIFO or device); the audit never writes to it.
 */
export function loadClassificationsFile(path: string): ClassificationEntry[] {
  const absolute = resolve(path)
  let text: string
  try {
    if (!statSync(absolute).isFile()) {
      throw new ClassificationInputError('classifications path is not a regular file')
    }
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    if (error instanceof ClassificationInputError) throw error
    throw new ClassificationInputError('classifications file cannot be read')
  }
  return parseClassifications(text)
}

export type ClassificationTable = ReadonlyMap<
  string,
  { reason: string; source: ClassificationSource }
>

/**
 * PV's table plus an extension-supplied one. Both are reviewed under the same rules; a key that
 * appears in both is a defect (an extension may not restate a PV classification).
 */
export function mergeClassifications(
  pv: readonly ClassificationEntry[],
  extension: readonly ClassificationEntry[]
): ClassificationTable {
  const table = new Map<string, { reason: string; source: ClassificationSource }>()
  for (const entry of pv) table.set(entry.route, { reason: entry.reason, source: 'pv' })
  for (const entry of extension) {
    if (table.has(entry.route)) {
      throw new ClassificationInputError(
        `extension classification ${entry.route} duplicates a PV classification`
      )
    }
    table.set(entry.route, { reason: entry.reason, source: 'extension' })
  }
  return table
}

export type AuditClass = 'secureRoute' | 'classified-pv' | 'classified-extension' | 'head-clone'

export type AuditReport = {
  total: number
  counts: Record<AuditClass, number>
  failures: string[]
  ok: boolean
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function isSecureRouteBuilt(route: ObservedRoute): boolean {
  const marker = route.pvRoute as { builtBy?: string } | undefined
  return marker?.builtBy === 'secureRoute'
}

function routeKeyOf(route: ObservedRoute): string {
  return `${route.method} ${route.url}`
}

function duplicateFailures(routes: readonly ObservedRoute[]): string[] {
  const origins = new Map<string, string[]>()
  for (const route of routes) {
    const key = routeKeyOf(route)
    origins.set(key, [...(origins.get(key) ?? []), route.origin])
  }
  return [...origins.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => `duplicate route key ${key} (origins: ${list.join(', ')})`)
}

type Classified = { cls: AuditClass } | { failure: string }

function classifyOne(route: ObservedRoute, table: ClassificationTable): Classified {
  if (isSecureRouteBuilt(route)) return { cls: 'secureRoute' }
  const direct = table.get(routeKeyOf(route))
  if (direct) {
    return { cls: direct.source === 'pv' ? 'classified-pv' : 'classified-extension' }
  }
  if (route.method === 'HEAD' && table.has(`GET ${route.url}`)) return { cls: 'head-clone' }
  return {
    failure: `unclassified route ${routeKeyOf(route)} (origin: ${route.origin}); build it with secureRoute() or add a classification with a reason`,
  }
}

/**
 * Proves every observed route is `secureRoute`-built or classified. A HEAD route Fastify derived
 * from a classified GET needs no entry of its own. A classification whose route is not on the
 * composed API fails (a stale entry would silently stop reviewing anything).
 */
export function classifyRoutes(
  routes: readonly ObservedRoute[],
  table: ClassificationTable
): AuditReport {
  const failures = duplicateFailures(routes)
  const counts: Record<AuditClass, number> = {
    secureRoute: 0,
    'classified-pv': 0,
    'classified-extension': 0,
    'head-clone': 0,
  }
  const observedKeys = new Set(routes.map(routeKeyOf))
  const ordered = [...routes].sort((left, right) =>
    compareCodeUnits(routeKeyOf(left), routeKeyOf(right))
  )
  for (const route of ordered) {
    const result = classifyOne(route, table)
    if ('cls' in result) counts[result.cls] += 1
    else failures.push(result.failure)
  }
  for (const key of [...table.keys()].sort(compareCodeUnits)) {
    if (!observedKeys.has(key)) failures.push(`stale classification ${key}: no such route`)
  }
  failures.sort(compareCodeUnits)
  return { total: routes.length, counts, failures, ok: failures.length === 0 }
}

/** Deterministic, path-free, env-free report text (CI logs stay diff-stable). */
export function formatAuditReport(report: AuditReport): string {
  const lines = [
    `route audit: ${report.ok ? 'PASS' : 'FAIL'}`,
    `routes observed: ${report.total}`,
    `  secureRoute-built: ${report.counts.secureRoute}`,
    `  classified (PV table): ${report.counts['classified-pv']}`,
    `  classified (extension table): ${report.counts['classified-extension']}`,
    `  HEAD clones of classified GET routes: ${report.counts['head-clone']}`,
  ]
  if (report.failures.length > 0) {
    lines.push(`failures: ${report.failures.length}`)
    for (const failure of report.failures) lines.push(`  - ${failure}`)
  }
  return lines.join('\n')
}
