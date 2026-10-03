import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { REPLACEMENT_MAP_PATH, REPLACEMENT_MAP_VERSION } from '../replacement-map.js'

/** One replacement, resolved against the app root: both paths are real, absolute, forward-slash. */
export interface ResolvedReplacement {
  target: string
  host: string
  with: string
  /** The entry's host path as the map spelled it (for messages). */
  hostRel: string
  withRel: string
}

export interface LoadedMap {
  entries: ResolvedReplacement[]
}

export interface MapSource {
  appRoot: string
  mapPath?: string
  lockPath?: string
}

const LOCK_BASENAME = 'composition.lock.json'

/** A path this plugin handles as a key is a real, forward-slash path (a symlinked checkout and
 * Windows separators compare equal; case is never folded). */
export function normalizeFsPath(path: string): string {
  return path.replaceAll('\\', '/')
}

export function realPathOf(path: string): string {
  try {
    return normalizeFsPath(realpathSync(path))
  } catch {
    return normalizeFsPath(resolve(path))
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function relativeProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return 'is not a path'
  if (path.includes('\\')) return 'uses backslashes'
  if (isAbsolute(path)) return 'is absolute'
  if (path.split('/').includes('..')) return 'contains ".."'
  return null
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error(`pv-replace: ${what} ${path} is not valid JSON; run pv-compose.`)
  }
}

/** The targets the committed lock records, or null when there is no lock yet (an early dev run). */
function lockTargets(lockPath: string): Set<string> | null {
  if (!existsSync(lockPath)) return null
  const lock = readJson(lockPath, 'lock') as { replacements?: { target?: string }[] }
  return new Set((lock.replacements ?? []).flatMap((entry) => entry.target ?? []))
}

function resolveEntry(appRoot: string, raw: unknown): ResolvedReplacement {
  const entry = raw as { target?: unknown; host?: unknown; with?: unknown } | null
  const hostRel = entry?.host
  const withRel = entry?.with
  for (const [label, path] of [
    ['host', hostRel],
    ['with', withRel],
  ] as const) {
    const problem = relativeProblem(path)
    if (problem !== null) {
      throw new Error(
        `pv-replace: map entry ${String(hostRel)}: ${label} ${JSON.stringify(path)} ${problem}; the map holds paths relative to the app root.`
      )
    }
  }
  const src = join(appRoot, 'src')
  const host = resolve(appRoot, hostRel as string)
  const withAbs = resolve(appRoot, withRel as string)
  for (const path of [host, withAbs]) {
    if (!isInside(src, path)) {
      throw new Error(
        `pv-replace: map entry ${String(hostRel)}: ${path} is outside ${src}; a replacement stays inside src/.`
      )
    }
  }
  if (!existsSync(withAbs)) {
    throw new Error(
      `pv-replace: replacement for ${String(hostRel)} points at missing ${String(withRel)}; run pv-compose.`
    )
  }
  return {
    target: typeof entry?.target === 'string' ? entry.target : '',
    host: realPathOf(host),
    with: realPathOf(withAbs),
    hostRel: hostRel as string,
    withRel: withRel as string,
  }
}

/** Reads and validates `.pv-compose/replacements.json`. Integrity only: the shape, the version,
 * containment inside `<appRoot>/src`, the `with` files, and (when a lock exists) that every entry is
 * one the lock also records. Throws one `pv-replace:` message naming the fix; never returns a
 * partial map, and never prints file contents. */
export function loadReplacementMap(source: MapSource): LoadedMap {
  const appRoot = realpathSync(source.appRoot)
  const mapPath = source.mapPath ?? join(source.appRoot, REPLACEMENT_MAP_PATH)
  if (!existsSync(mapPath)) {
    throw new Error(
      `pv-replace: ${mapPath} not found; run pv-compose (a stale or skipped compose would serve PV's original files).`
    )
  }
  const raw = readJson(mapPath, 'map') as { schemaVersion?: unknown; replacements?: unknown }
  if (raw?.schemaVersion !== REPLACEMENT_MAP_VERSION) {
    throw new Error(
      `pv-replace: ${mapPath} has schemaVersion ${String(raw?.schemaVersion)}; this kit understands ${REPLACEMENT_MAP_VERSION}; upgrade @project-vault/composition-kit or re-run pv-compose.`
    )
  }
  if (!Array.isArray(raw.replacements)) {
    throw new TypeError(`pv-replace: ${mapPath} has no replacements list; run pv-compose.`)
  }
  const entries = (raw.replacements as unknown[]).map((entry) => resolveEntry(appRoot, entry))
  const targets = lockTargets(source.lockPath ?? join(source.appRoot, LOCK_BASENAME))
  if (targets !== null) {
    const unlisted = entries.find((entry) => !targets.has(entry.target))
    if (unlisted !== undefined) {
      throw new Error(
        `pv-replace: map entry ${unlisted.hostRel} is not in ${LOCK_BASENAME}; run pv-compose.`
      )
    }
  }
  return { entries }
}
