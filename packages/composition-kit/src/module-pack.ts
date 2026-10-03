import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareCodeUnits } from './paths.js'

/**
 * Story 68.14 AC-4 — reads the module pack's `apiRoutes.override` table for `composition.lock.json`.
 *
 * `--module-pack <dir>` names the module pack's package root. The kit resolves its entry from
 * `<dir>/package.json` (`exports["."]`, else `main`), imports it, and reads
 * `default.manifest.apiRoutes.override` ONLY: it never calls `hooksFactory()`. Importing runs the
 * entry's top-level code (the pack is trusted first-party code, the same as building it), in the
 * kit's own working directory and with the process's own env: the kit adds nothing. The import
 * target is the resolved `file://` URL only, and must stay inside `<dir>` after `realpath`.
 * A pack with no `main`/`exports["."]` is tolerated (an informational note, empty table): the flag
 * predates the table and also only feeds the extension-api version check.
 */

export interface ApiRouteOverrideLock {
  method: string
  url: string
  mode: 'replace' | 'wrap'
  replaceSecurity: boolean
}

export interface ModulePackRoutes {
  overrides: ApiRouteOverrideLock[]
  problems: string[]
  notes: string[]
}

const MAX_ERROR_TEXT = 500

/** The methods the lock schema accepts (the extension-api `API_ROUTE_METHODS` list). */
const LOCK_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `/x/` and `/x` are one route; the host route key has a leading slash and no trailing one. */
export function normalizeOverrideUrl(url: string): string {
  const rooted = url.startsWith('/') ? url : `/${url}`
  return rooted.length > 1 && rooted.endsWith('/') ? rooted.slice(0, -1) : rooted
}

function conditionTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return undefined
  const preferred = value['import'] ?? value['default']
  return typeof preferred === 'string' ? preferred : undefined
}

/** `exports["."]` (a string, or a conditions object's `import`/`default`), else `main`. */
function entryOf(manifest: Json): string | undefined {
  const exported = manifest['exports']
  const dot = isRecord(exported) && '.' in exported ? exported['.'] : exported
  const fromExports = conditionTarget(dot)
  if (fromExports !== undefined) return fromExports
  const main = manifest['main']
  return typeof main === 'string' ? main : undefined
}

function readPackageJson(dir: string): { manifest?: Json; problem?: string } {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return { problem: `module pack ${dir} has no package.json` }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isRecord(parsed)) return { manifest: parsed }
  } catch {
    // fall through to the same problem text
  }
  return { problem: `module pack ${dir}: package.json is not a JSON object` }
}

/** The pack entry's real path, inside `dir`, or the problem naming the pack. */
function resolveEntry(dir: string): { path?: string; problem?: string; note?: string } {
  const pkg = readPackageJson(dir)
  if (pkg.manifest === undefined) return { problem: pkg.problem ?? `module pack ${dir} is invalid` }
  const entry = entryOf(pkg.manifest)
  if (entry === undefined) {
    // `--module-pack` also serves the extension-api version check, which never needed an entry.
    return {
      note: `module pack ${dir} has no main or exports["."]: apiRouteOverrides not recorded`,
    }
  }
  const candidate = resolve(dir, entry)
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return { problem: `module pack ${dir}: entry ${entry} was not found` }
  }
  const real = realpathSync(candidate)
  const root = realpathSync(dir)
  if (!real.startsWith(`${root}${sep}`)) {
    return {
      problem: `module pack ${dir}: entry ${entry} resolves outside the module pack directory`,
    }
  }
  return { path: real }
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  return `${name}: ${message.slice(0, MAX_ERROR_TEXT)}`
}

function overrideFrom(raw: unknown, index: number): ApiRouteOverrideLock | string {
  const path = `apiRoutes.override[${index}]`
  if (!isRecord(raw)) return `${path} must be an object`
  const { method, url, mode, replaceSecurity } = raw
  if (typeof method !== 'string' || typeof url !== 'string') {
    return `${path} needs a string method and url`
  }
  if (!LOCK_METHODS.includes(method)) {
    return `${path}.method must be one of ${LOCK_METHODS.join(', ')}`
  }
  if (mode !== 'replace' && mode !== 'wrap') return `${path}.mode must be 'replace' or 'wrap'`
  return { method, url: normalizeOverrideUrl(url), mode, replaceSecurity: replaceSecurity === true }
}

function overridesOf(apiRoutes: unknown, dir: string): ModulePackRoutes {
  if (apiRoutes === undefined) return { overrides: [], problems: [], notes: [] }
  const list = isRecord(apiRoutes) ? apiRoutes['override'] : undefined
  if (!isRecord(apiRoutes) || (list !== undefined && !Array.isArray(list))) {
    return {
      overrides: [],
      notes: [],
      problems: [`module pack ${dir}: manifest.apiRoutes.override must be an array`],
    }
  }
  const converted = ((list ?? []) as unknown[]).map((entry, index) => overrideFrom(entry, index))
  const problems = converted
    .filter((entry): entry is string => typeof entry === 'string')
    .map((problem) => `module pack ${dir}: manifest.${problem}`)
  const byKey = new Map(
    converted
      .filter((entry): entry is ApiRouteOverrideLock => typeof entry !== 'string')
      .map((entry) => [`${entry.method} ${entry.url}`, entry])
  )
  const overrides = [...byKey.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, entry]) => entry)
  return { overrides, problems, notes: [] }
}

export async function readModulePackRoutes(dir: string): Promise<ModulePackRoutes> {
  const resolved = resolveEntry(dir)
  if (resolved.path === undefined) {
    const notes = resolved.note === undefined ? [] : [resolved.note]
    const problems = resolved.problem === undefined ? [] : [resolved.problem]
    return { overrides: [], problems, notes }
  }
  let loaded: unknown
  try {
    loaded = await import(/* @vite-ignore */ pathToFileURL(resolved.path).href)
  } catch (error) {
    return {
      overrides: [],
      notes: [],
      problems: [`module pack ${dir} failed to import: ${describeError(error)}`],
    }
  }
  const exported = isRecord(loaded) ? loaded['default'] : undefined
  const manifest = isRecord(exported) ? exported['manifest'] : undefined
  if (!isRecord(manifest)) {
    return {
      overrides: [],
      notes: [],
      problems: [`module pack ${dir}: module pack entry has no default.manifest`],
    }
  }
  return overridesOf(manifest['apiRoutes'], dir)
}
