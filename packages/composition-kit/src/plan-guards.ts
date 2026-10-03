// Story 68.9: the composer's guard stage. It loads and validates the pack's guard entries (manifest
// field `guards`), merges them into the generated data module PV's web guards read, records the
// per-section hashes the guards verify, and computes `excludedPvTests` from the host's subject map.
import { existsSync, readFileSync } from 'node:fs'
import {
  GUARD_ENTRIES_PATH,
  generatedEntriesText,
  mergeGuardEntries,
  sectionHashes,
  validateGuardEntries,
  type GuardEntriesInput,
} from './guard-entries.js'
import { excludedPvTests, exclusionNotes, readTestSubjects } from './excluded-tests.js'
import { loadManifest } from './manifest.js'
import type { MaterializeResult } from './materialize.js'
import { normalizePackPath } from './paths.js'
import type { FileSource, OverlayResult } from './overlay.js'
import type { Host, Pack } from './sources.js'
import type { UiPackManifest } from './types.js'

export interface LoadedGuardEntries {
  /** The pack-relative path of the entries file (it is reached, never copied). */
  rel?: string
  entries?: GuardEntriesInput
  problems: string[]
  notes: string[]
}

/** Loads and validates the entries file the manifest names; nothing when it names none. */
export async function loadGuardEntries(
  manifest: UiPackManifest,
  pack: Pack,
  resolveFrom: string
): Promise<LoadedGuardEntries> {
  if (manifest.guards === undefined) return { problems: [], notes: [] }
  const rel = normalizePackPath(manifest.guards)
  if (rel === null) {
    return {
      problems: [`guards: "${manifest.guards}" must be a path inside the UI pack.`],
      notes: [],
    }
  }
  const abs = pack.files.get(rel)
  if (abs === undefined) {
    return {
      rel,
      problems: [`guards: ${rel} is named by the manifest but is not in the UI pack.`],
      notes: [],
    }
  }
  let raw: unknown
  try {
    raw = await loadManifest(abs, { resolveFrom })
  } catch (error) {
    return {
      rel,
      problems: [`guards: ${rel} could not be loaded: ${(error as Error).message}`],
      notes: [],
    }
  }
  const validation = validateGuardEntries(raw)
  return {
    rel,
    problems: validation.problems.map((problem) => `guards (${rel}): ${problem}`),
    notes: validation.notes,
    ...(validation.entries === undefined ? {} : { entries: validation.entries }),
  }
}

export interface GuardStageInput {
  manifest: UiPackManifest
  host: Host
  overlay: OverlayResult
  mat: MaterializeResult
  files: Map<string, FileSource>
  loaded: LoadedGuardEntries
}

export interface GuardStage {
  problems: string[]
  notes: string[]
  guardEntries: Record<string, string>
  excludedPvTests: string[]
}

function hostEntriesFile(host: Host): unknown {
  const abs = host.files.get(GUARD_ENTRIES_PATH)
  if (abs === undefined || !existsSync(abs)) return undefined
  return JSON.parse(readFileSync(abs, 'utf8')) as unknown
}

/** Writes the generated entries module into the composed file set (only when the pack authored
 * entries) and returns the hashes of what the composed tree will hold. */
function entriesStage(
  input: GuardStageInput
): Pick<GuardStage, 'problems' | 'notes' | 'guardEntries'> {
  const { manifest, host, overlay, mat, files, loaded } = input
  const base = hostEntriesFile(host)
  if (manifest.guards === undefined) {
    return { problems: [], notes: [], guardEntries: sectionHashes(base) }
  }
  const merge = mergeGuardEntries(loaded.entries, {
    relocated: new Map(mat.relocated.map((entry) => [entry.source, entry.dest])),
    overlayPaths: new Set([...overlay.overrides, ...overlay.additions].map((entry) => entry.path)),
    changedHostPaths: new Set([
      ...overlay.changedHostPaths,
      ...overlay.replacements.map((entry) => entry.hostPath),
    ]),
  })
  if (loaded.problems.length > 0 || merge.problems.length > 0) {
    return { problems: merge.problems, notes: [], guardEntries: {} }
  }
  const text = generatedEntriesText(merge.merged)
  files.set(GUARD_ENTRIES_PATH, { kind: 'text', content: Buffer.from(text) })
  return {
    problems: [],
    notes:
      base === undefined
        ? [
            'host has no generated guard entries module; this web-host version does not read guard entries',
          ]
        : [],
    guardEntries: sectionHashes(JSON.parse(text) as unknown),
  }
}

function testStage(
  input: GuardStageInput
): Pick<GuardStage, 'problems' | 'notes' | 'excludedPvTests'> {
  const read = readTestSubjects(input.host.dir)
  if (read.subjects === undefined) {
    return { problems: read.problems, notes: read.notes, excludedPvTests: [] }
  }
  const changed = new Set([
    ...input.overlay.changedHostPaths,
    ...input.overlay.replacements.map((entry) => entry.hostPath),
  ])
  const excluded = excludedPvTests({
    subjects: read.subjects,
    changed,
    notPvTests: input.overlay.changedHostPaths,
  })
  return {
    problems: [],
    notes: exclusionNotes(excluded, read.subjects.size),
    excludedPvTests: excluded,
  }
}

export function guardStage(input: GuardStageInput): GuardStage {
  const entries = entriesStage(input)
  const tests = testStage(input)
  return {
    problems: [...entries.problems, ...tests.problems],
    notes: [...input.loaded.notes, ...entries.notes, ...tests.notes],
    guardEntries: entries.guardEntries,
    excludedPvTests: tests.excludedPvTests,
  }
}
