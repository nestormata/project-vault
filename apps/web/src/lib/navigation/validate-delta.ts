// Story 68.7 AC-7: integrity validation of a whole nav delta (never an allowlist). Run by the
// shipped `composed-nav.test.ts` over CM's real delta in CI and by the dev-mode check. Problems:
// unknown surface key, op shape errors, an operative op on an id that does not exist in that
// surface (naming the owning surface when it exists elsewhere, Q4), duplicate inserted ids, cycles,
// invalid reorders, labelless items, actions without handlers, malformed ids. Notes: `hide`/`remove`
// of an absent id, and a change to the footer's source or license link (Q12, never refused).
import { applyNavDelta } from './apply-delta.js'
import { NAV_SURFACES, isNavId, surfaceOfNavId } from './nav-registry.js'
import { surfaceItems } from './surfaces/index.js'
import type { NavSurfaceId } from './types.js'

export interface NavDeltaFindings {
  problems: string[]
  notes: string[]
}

const SOURCE_OFFER_IDS: ReadonlySet<string> = new Set(['footer.github', 'footer.license'])
const SOURCE_OFFER_OPS: ReadonlySet<string> = new Set([
  'hide',
  'remove',
  'replace',
  'relabel',
  'move',
])

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const SURFACE_IDS: ReadonlySet<string> = new Set(NAV_SURFACES.map((surface) => surface.id))

export function isNavSurfaceId(value: string): value is NavSurfaceId {
  return SURFACE_IDS.has(value)
}

/** Q12: an informational note per footer source/license item the delta changes. */
function sourceOfferNotes(surface: string, ops: readonly unknown[]): string[] {
  const touched = new Set<string>()
  for (const op of ops) {
    const id = isRecord(op) && Object.hasOwn(op, 'id') ? op.id : undefined
    const name = isRecord(op) && Object.hasOwn(op, 'op') ? op.op : undefined
    if (typeof id === 'string' && SOURCE_OFFER_IDS.has(id) && SOURCE_OFFER_OPS.has(String(name))) {
      touched.add(id)
    }
  }
  return [...touched].map(
    (id) =>
      `${surface}: the delta changes ${id}; check AGPL-3.0 §13 source-offer obligations (see DW-127/DW-225)`
  )
}

function surfaceFindings(surface: string, ops: unknown, findings: NavDeltaFindings): void {
  if (!isNavId(surface)) {
    findings.problems.push(`nav delta surface key "${surface}" breaks the id grammar`)
    return
  }
  if (!isNavSurfaceId(surface)) {
    findings.problems.push(`unknown nav surface "${surface}"`)
    return
  }
  if (!Array.isArray(ops)) {
    findings.problems.push(`nav delta surface "${surface}" must be an array of operations`)
    return
  }
  const applied = applyNavDelta<never>(surface, surfaceItems(surface), ops, {
    ownerOf: surfaceOfNavId,
  })
  findings.problems.push(...applied.problems)
  findings.notes.push(...applied.notes, ...sourceOfferNotes(surface, ops))
}

/** Validates every surface of a delta against PV's full trees. Pure; sorted output. */
export function validateNavDelta(delta: unknown): NavDeltaFindings {
  const findings: NavDeltaFindings = { problems: [], notes: [] }
  if (!isRecord(delta)) {
    return { problems: ['nav delta must be an object of surfaces'], notes: [] }
  }
  for (const [surface, ops] of Object.entries(delta)) surfaceFindings(surface, ops, findings)
  findings.problems.sort(compareCodeUnits)
  findings.notes.sort(compareCodeUnits)
  return findings
}
