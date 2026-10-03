import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { normalizeFsPath, realPathOf } from './replace-map.js'

// `pv-original:<specifier>` names one of PV's own files by the specifier PV would write: `$lib/...`
// or a path relative to the importing file. Both are resolved here, directly against the composed
// app, and NOT through the plugin pipeline: a nested `this.resolve` passes through every other
// plugin (SvelteKit's guard among them), and which of those pass the "leave this id alone" flag on
// to their own nested resolves differs, so a pipeline resolve can hand back the replacement itself.
// Any other specifier (an alias of the consumer's own) falls back to the pipeline.

const LIB_PREFIX = '$lib/'
const APPENDED = ['.svelte', '.ts', '.js', '.mjs', '.mts']
const INDEXES = ['/index.svelte', '/index.ts', '/index.js']
/** TypeScript's "write `.js`, mean `.ts`": the import spelling and the file on disk. */
const TS_SPELLING: readonly (readonly [string, string])[] = [
  ['.js', '.ts'],
  ['.jsx', '.tsx'],
  ['.mjs', '.mts'],
]

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function candidates(base: string): string[] {
  const swapped = TS_SPELLING.flatMap(([js, ts]) =>
    base.endsWith(js) ? [`${base.slice(0, -js.length)}${ts}`] : []
  )
  return [
    base,
    ...APPENDED.map((extension) => `${base}${extension}`),
    ...swapped,
    ...INDEXES.map((suffix) => `${base}${suffix}`),
  ]
}

export type OriginalResolution =
  /** The real path of the file, with the specifier's `?query#hash` kept. */
  | { kind: 'file'; id: string }
  /** The specifier names a place outside `<appRoot>/src`. */
  | { kind: 'outside'; path: string }
  /** Not a form this resolver understands, or no such file: ask the pipeline. */
  | { kind: 'unknown' }

/** The file `rest` (`pv-original:` stripped) means from `importer`, when it is a `$lib/...` or a
 * relative specifier. */
export function resolveOriginalFile(
  rest: string,
  importer: string | undefined,
  appRoot: string
): OriginalResolution {
  const cut = rest.search(/[?#]/)
  const spelled = cut === -1 ? rest : rest.slice(0, cut)
  const suffix = cut === -1 ? '' : rest.slice(cut)
  const src = join(realPathOf(appRoot), 'src')
  let base: string
  if (spelled.startsWith(LIB_PREFIX)) {
    base = posix.normalize(`${normalizeFsPath(src)}/lib/${spelled.slice(LIB_PREFIX.length)}`)
  } else if (spelled.startsWith('./') || spelled.startsWith('../')) {
    if (importer === undefined) return { kind: 'unknown' }
    const from = isAbsolute(importer) ? dirname(importer) : resolve(dirname(importer))
    base = normalizeFsPath(resolve(from, spelled))
  } else {
    return { kind: 'unknown' }
  }
  const prefix = `${normalizeFsPath(src)}/`
  if (!`${normalizeFsPath(resolve(base))}/`.startsWith(prefix))
    return { kind: 'outside', path: base }
  const found = candidates(base).find(isFile)
  return found === undefined
    ? { kind: 'unknown' }
    : { kind: 'file', id: `${realPathOf(found)}${suffix}` }
}
