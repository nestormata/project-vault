import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './lock.js'
import type { Relocated } from './materialize.js'
import type { ReplacementRecord } from './overlay.js'
import { compareCodeUnits } from './paths.js'

/** Where the composer leaves the map `pvReplace` reads, relative to the app root. Generated on
 * every compose, never committed (the app's `.gitignore` lists `.pv-compose/`), never read by
 * `--check`: the lock already records the same facts. */
export const REPLACEMENT_MAP_PATH = '.pv-compose/replacements.json'
export const REPLACEMENT_MAP_VERSION = 1

export interface ReplacementMapEntry {
  /** The manifest key (`$lib/...`). */
  target: string
  /** The PV file that is shadowed, relative to the app root (`src/lib/...`). */
  host: string
  /** The materialized CM file that shadows it, relative to the app root. */
  with: string
}

export interface ReplacementMap {
  schemaVersion: number
  replacements: ReplacementMapEntry[]
}

/** The map text: sorted by `host` by code-unit order, two-space indent, trailing newline, relative
 * paths only, no timestamps. The same input yields the same bytes on any machine. */
export function replacementMapText(
  replacements: readonly ReplacementRecord[],
  relocated: readonly Relocated[]
): string {
  const destOf = new Map(relocated.map((entry) => [entry.source, entry.dest]))
  const entries = replacements
    .map((record) => ({
      target: record.target,
      host: record.hostPath,
      with: destOf.get(record.with) ?? record.with,
    }))
    .sort((a, b) => compareCodeUnits(a.host, b.host))
  const map: ReplacementMap = { schemaVersion: REPLACEMENT_MAP_VERSION, replacements: entries }
  return `${JSON.stringify(map, null, 2)}\n`
}

/** Writes the map atomically, and only when its bytes changed (the incremental path calls this on
 * every compose; an unchanged map must not look like a change to the dev server's watcher). */
export function writeReplacementMap(appRoot: string, text: string): boolean {
  const path = join(appRoot, REPLACEMENT_MAP_PATH)
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, text)
  return true
}
