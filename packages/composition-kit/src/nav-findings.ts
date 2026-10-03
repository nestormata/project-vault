// Story 68.7 AC-9 (design §7 "Drift", §11): what compose time checks about a pack's nav delta
// against the web-host it composes onto, and what the lock records. Integrity only, never an
// list of permitted changes: an operative reference to a vanished id fails (the change cannot apply), a reference
// under the wrong surface fails (Q4), a pack-inserted id that web-host now defines fails (an
// accidental collision); everything else is a note. New web-host ids are inherited (shown) until
// the pack changes them (ADR 0007 guardrail 2): a note, never a failure.
//
// An older web-host (no `nav-ids.json` with `delta: 1`) keeps Story 68-3's behaviour exactly: the
// nav file is materialized, the previous lock's references are carried forward and checked, and
// the "nav delta not applied" note is printed.
import type * as TypeScript from 'typescript'
import type { CompositionLock } from './lock.js'
import { extractNavReferences, type NavIdReference } from './nav-references.js'
import { compareCodeUnits } from './paths.js'
import { checkNavIds, type NavReference, type Registries } from './registry.js'

export interface NavFindings {
  problems: string[]
  notes: string[]
  /** `navIdsReferenced`: host ids the pack names (deduplicated, operative if any use is). */
  referenced: NavReference[]
  /** `navIdsDeclared`: ids the pack inserts. Absent for an older host. */
  declared?: string[]
  /** `navIdsHost`: the host's nav ids this lock was written against. Absent for an older host. */
  host?: string[]
}

export interface NavFindingsInput {
  /** The pack's nav file as composed (`contributions.nav`) and its text, if the pack has one. */
  navFile?: { path: string; code: string }
  registries: Registries
  existingLock?: CompositionLock
  /** Loads the app's TypeScript (`requirePeer`), only when there is a nav file to read. */
  typescript: () => typeof TypeScript
}

const SOURCE_OFFER: ReadonlySet<string> = new Set(['footer.github', 'footer.license'])
const SOURCE_OFFER_OPS: ReadonlySet<string> = new Set(['hide', 'remove', 'replace'])

function dedupe(references: readonly NavReference[]): NavReference[] {
  const merged = new Map<string, boolean>()
  for (const { id, operative } of references) merged.set(id, operative || merged.get(id) === true)
  return [...merged]
    .map(([id, operative]) => ({ id, operative }))
    .sort((a, b) => compareCodeUnits(a.id, b.id))
}

function surfaceProblems(
  references: readonly NavIdReference[],
  owners: ReadonlyMap<string, string | null>
): string[] {
  return references.flatMap((reference) => {
    const owner = owners.get(reference.id)
    if (
      reference.surface === null ||
      owner === undefined ||
      owner === null ||
      owner === reference.surface
    ) {
      return []
    }
    return [`Nav id "${reference.id}" belongs to surface "${owner}", not "${reference.surface}"`]
  })
}

function inheritanceNotes(
  host: readonly string[],
  previous: readonly string[] | undefined
): string[] {
  if (previous === undefined) {
    return [
      `nav ids: web-host defines ${host.length}; every one this pack's nav does not change is inherited (shown)`,
    ]
  }
  const known = new Set(previous)
  return host
    .filter((id) => !known.has(id))
    .map((id) => `nav id "${id}" is new in web-host and inherited (shown) by this pack's nav`)
}

function sourceOfferNotes(references: readonly NavIdReference[]): string[] {
  const touched = new Set(
    references
      .filter(
        (r) => r.role === 'target' && SOURCE_OFFER.has(r.id) && SOURCE_OFFER_OPS.has(r.op ?? '')
      )
      .map((r) => r.id)
  )
  return [...touched].map(
    (id) =>
      `nav delta changes ${id}: check the AGPL-3.0 §13 source-offer obligations (see DW-127/DW-225); never refused`
  )
}

/** Story 68-3's behaviour for an older web-host: carry the previous references forward. */
function olderHost(input: NavFindingsInput): NavFindings {
  const referenced = input.existingLock?.navIdsReferenced ?? []
  const checked = checkNavIds(referenced, input.registries.navIds)
  return { ...checked, referenced }
}

export function navFindings(input: NavFindingsInput): NavFindings {
  const { registries } = input
  if (registries.navDelta !== true || registries.navEntries === undefined) return olderHost(input)
  const host = [...new Set(registries.navEntries.map((entry) => entry.id))].sort(compareCodeUnits)
  const notes = inheritanceNotes(host, input.existingLock?.navIdsHost)
  if (input.navFile === undefined)
    return { problems: [], notes, referenced: [], declared: [], host }
  const read = extractNavReferences(
    input.navFile.code,
    input.typescript(),
    input.navFile.path,
    registries.navSurfaces ?? []
  )
  const declared = [...new Set(read.declared.map((entry) => entry.id))].sort(compareCodeUnits)
  const declaredSet = new Set(declared)
  const hostRefs = read.references.filter((reference) => !declaredSet.has(reference.id))
  const owners = new Map(registries.navEntries.map((entry) => [entry.id, entry.surface]))
  const referenced = dedupe(hostRefs)
  const vanished = checkNavIds(referenced, host)
  const collisions = declared
    .filter((id) => owners.has(id))
    .map(
      (id) =>
        `nav id "${id}" is inserted by this pack but web-host now defines it; rename your item or replace PV's`
    )
  return {
    problems: [
      ...read.problems,
      ...vanished.problems,
      ...surfaceProblems(hostRefs, owners),
      ...collisions,
    ],
    notes: [...notes, ...read.notes, ...vanished.notes, ...sourceOfferNotes(hostRefs)],
    referenced,
    declared,
    host,
  }
}
