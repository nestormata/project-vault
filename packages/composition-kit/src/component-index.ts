import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReplacementRecord } from './overlay.js'
import { compareCodeUnits } from './paths.js'

// Story 68.5 AC-9: web-host may ship `manifests/component-index.json` (a registry of its UI modules
// with a stability signal). The kit reads the minimal shape below, ignores every other field, and
// uses it ONLY to add informational `notes` to the lock. A replacement of any module, stable or not,
// is never refused, and a malformed or newer index is ignored with a note, never a failure.

const SUPPORTED_SCHEMA = 1
const FILE = 'component-index.json'
/** Replacing these runs with PV's server trust (invariant 0): never refused, but visible. */
const SERVER_SIDE_PREFIXES = ['src/lib/server/', 'src/lib/api/']

export interface ComponentIndexRead {
  /** Host-relative path -> `stable` | `unmarked`; absent when the host ships no usable index. */
  stability?: Map<string, string>
  notes: string[]
}

/** Reads the host's component index, if it ships one. */
export function readComponentIndex(host: string): ComponentIndexRead {
  const path = join(host, 'manifests', FILE)
  if (!existsSync(path)) return { notes: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion?: unknown
      components?: unknown
    }
    if (raw.schemaVersion !== SUPPORTED_SCHEMA || !Array.isArray(raw.components)) {
      throw new Error('unexpected shape')
    }
    const stability = new Map<string, string>()
    for (const entry of raw.components as { path?: unknown; stability?: unknown }[]) {
      if (typeof entry.path === 'string') {
        stability.set(
          entry.path,
          typeof entry.stability === 'string' ? entry.stability : 'unmarked'
        )
      }
    }
    return { stability, notes: [] }
  } catch {
    return {
      notes: [
        `manifests/${FILE} was ignored (expected { schemaVersion: ${SUPPORTED_SCHEMA}, components: [...] }); stability signals are unavailable`,
      ],
    }
  }
}

/** Informational notes for the lock: each replacement's stability signal (and a note when the
 * target is not in the index), and a marker on server-side modules. Never a problem. */
export function replacementNotes(
  replacements: readonly ReplacementRecord[],
  stability: ReadonlyMap<string, string> | undefined
): string[] {
  const notes: string[] = []
  for (const record of replacements) {
    if (SERVER_SIDE_PREFIXES.some((prefix) => record.hostPath.startsWith(prefix))) {
      notes.push(`replacement ${record.target}: server-side module`)
    }
    if (stability === undefined) continue
    const signal = stability.get(record.hostPath)
    notes.push(
      signal === undefined
        ? `replacement ${record.target}: not in manifests/${FILE} (no stability signal)`
        : `replacement ${record.target}: ${signal}`
    )
  }
  return notes.sort(compareCodeUnits)
}
