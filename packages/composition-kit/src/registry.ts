import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareCodeUnits } from './paths.js'

// The registries later stories generate and ship in web-host's `manifests/` (68-4 injection
// points, 68-7 nav ids). The kit reads the minimal shapes below and ignores every other field, so
// those stories may add fields without a kit release. `schemaVersion` 1 is the only known version.

const SUPPORTED_SCHEMA = 1

export interface InjectionPointRecord {
  name: string
  file: string | null
}

export interface Registries {
  injectionPoints?: InjectionPointRecord[]
  navIds?: string[]
  problems: string[]
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readList(
  host: string,
  name: string,
  key: string,
  problems: string[],
  pick: (entry: Rec) => unknown
): unknown[] | undefined {
  const path = join(host, 'manifests', name)
  if (!existsSync(path)) return undefined
  try {
    const raw = readJson(path)
    const list = isRecord(raw) ? new Map(Object.entries(raw)).get(key) : undefined
    if (!isRecord(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA || !Array.isArray(list)) {
      throw new Error(`expected { schemaVersion: ${SUPPORTED_SCHEMA}, ${key}: [...] }`)
    }
    return (list as unknown[]).map((entry) => {
      if (!isRecord(entry)) throw new Error(`${key} entries must be objects`)
      return pick(entry)
    })
  } catch (error) {
    problems.push(`manifests/${name}: ${(error as Error).message}`)
    return undefined
  }
}

export function readRegistries(host: string): Registries {
  const problems: string[] = []
  const points = readList(host, 'injection-points.json', 'points', problems, (entry) => ({
    name: String(entry.name),
    file: typeof entry.file === 'string' ? entry.file : null,
  }))
  const ids = readList(host, 'nav-ids.json', 'ids', problems, (entry) => String(entry.id))
  const registries: Registries = { problems }
  if (points !== undefined) registries.injectionPoints = points as InjectionPointRecord[]
  if (ids !== undefined) registries.navIds = ids as string[]
  return registries
}

export interface InjectionCheck {
  problems: string[]
  notes: string[]
  used: InjectionPointRecord[]
}

function checkOne(
  name: string,
  known: Map<string, string | null>,
  changedFiles: ReadonlySet<string>,
  previous: ReadonlyMap<string, string | null>,
  out: InjectionCheck
): void {
  if (known.has(name)) {
    out.used.push({ name, file: known.get(name) ?? null })
    return
  }
  const lastFile = previous.get(name)
  out.used.push({ name, file: lastFile ?? null })
  if (lastFile === undefined || lastFile === null) {
    out.problems.push(
      `Injection point "${name}" does not exist in web-host's injection-points.json`
    )
  } else if (changedFiles.has(lastFile)) {
    out.notes.push(
      `injection point "${name}" no longer exists because this pack overrides or removes ${lastFile}, which contained it`
    )
  } else {
    out.problems.push(
      `Injection point "${name}" vanished from web-host (it used to live in ${lastFile}) and this pack did not override that file`
    )
  }
}

/** Checks the injection point names the pack uses against the registry, when the host ships one.
 * Absent registry: a note (never a silent pass) and the names are still recorded. */
export function checkInjectionPoints(
  usedNames: readonly string[],
  registry: readonly InjectionPointRecord[] | undefined,
  changedFiles: ReadonlySet<string>,
  previous: readonly InjectionPointRecord[] = []
): InjectionCheck {
  const names = [...new Set(usedNames)].sort(compareCodeUnits)
  const out: InjectionCheck = { problems: [], notes: [], used: [] }
  if (registry === undefined) {
    if (names.length > 0) {
      out.notes.push(
        'injection point names not validated: this web-host ships no injection-points.json'
      )
    }
    out.used = names.map((name) => ({ name, file: null }))
    return out
  }
  const known = new Map(registry.map((point) => [point.name, point.file]))
  const lastSeen = new Map(previous.map((point) => [point.name, point.file]))
  for (const name of names) checkOne(name, known, changedFiles, lastSeen, out)
  return out
}

export interface NavReference {
  id: string
  /** `move`/`rename`/`reorder`/`insert-relative` targets are operative; `hide`/`remove` are not. */
  operative: boolean
}

export function checkNavIds(
  references: readonly NavReference[],
  registry: readonly string[] | undefined
): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  if (registry === undefined) {
    if (references.length > 0)
      notes.push('nav ids not validated: this web-host ships no nav-ids.json')
    return { problems, notes }
  }
  const known = new Set(registry)
  for (const reference of references.filter((entry) => !known.has(entry.id))) {
    if (reference.operative) {
      problems.push(
        `Nav id "${reference.id}" vanished from web-host and an operative nav change targets it`
      )
    } else {
      notes.push(
        `nav id "${reference.id}" vanished from web-host; it is only hidden or removed, so nothing to do`
      )
    }
  }
  return { problems, notes }
}
