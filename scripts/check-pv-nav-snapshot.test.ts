// Story 68.10 AC-9(c) / Q11: PV's own CM-free build keeps its native navigation. The committed
// snapshot (surfaces, native item ids, parents, conditions: exactly what the packed
// `manifests/nav-ids.json` publishes) is taken at 68-7's merge. A PV nav change needs an explicit
// snapshot update in the same PR: that is the intended review signal, never a restriction on what a
// UI pack may change. The identity half (an empty delta applies as the identity) is proven by
// apps/web/src/lib/navigation/apply-delta.test.ts and nav-render-oracle.test.ts, referenced here.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAV_IDS, NAV_SURFACES } from '../apps/web/src/lib/navigation/nav-registry.js'
import { buildNavIdsManifest } from './lib/web-host/package-manifest.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = join(root, 'scripts/web-host-consumer-fixture/pv-nav.main.json')

interface NavSnapshot {
  surfaces: { id: string }[]
  ids: { id: string; surface: string; parent: string | null; conditional: boolean }[]
}

/** The differences between the committed snapshot and the native nav, one message each. */
export function navSnapshotDiff(expected: NavSnapshot, actual: NavSnapshot): string[] {
  const problems: string[] = []
  const actualSurfaces = new Set(actual.surfaces.map((surface) => surface.id))
  for (const surface of expected.surfaces) {
    if (!actualSurfaces.has(surface.id)) problems.push(`surface ${surface.id} is gone`)
  }
  const expectedSurfaces = new Set(expected.surfaces.map((surface) => surface.id))
  for (const surface of actual.surfaces) {
    if (!expectedSurfaces.has(surface.id)) problems.push(`surface ${surface.id} is new`)
  }
  const actualIds = new Map(actual.ids.map((entry) => [entry.id, entry]))
  for (const entry of expected.ids) {
    const found = actualIds.get(entry.id)
    if (found === undefined) problems.push(`nav id ${entry.id} is gone`)
    else if (JSON.stringify(found) !== JSON.stringify(entry))
      problems.push(`nav id ${entry.id} changed (surface, parent or condition)`)
  }
  const expectedIds = new Set(expected.ids.map((entry) => entry.id))
  for (const entry of actual.ids) {
    if (!expectedIds.has(entry.id)) problems.push(`nav id ${entry.id} is new`)
  }
  return problems
}

const fromRegistry = (): NavSnapshot =>
  JSON.parse(buildNavIdsManifest({ surfaces: NAV_SURFACES, ids: NAV_IDS })) as NavSnapshot

describe('the native nav snapshot names a deliberate change (AC-9c self-tests)', () => {
  const base = (): NavSnapshot => ({
    surfaces: [{ id: 'primary' }],
    ids: [{ id: 'primary.home', surface: 'primary', parent: null, conditional: false }],
  })

  it('accepts an identical snapshot', () => {
    expect(navSnapshotDiff(base(), base())).toEqual([])
  })

  it('names an added native item, a removed one and a changed condition', () => {
    const added = base()
    added.ids.push({ id: 'primary.new', surface: 'primary', parent: null, conditional: false })
    expect(navSnapshotDiff(base(), added)).toEqual(['nav id primary.new is new'])
    expect(navSnapshotDiff(added, base())).toEqual(['nav id primary.new is gone'])
    const changed = base()
    changed.ids[0] = { id: 'primary.home', surface: 'primary', parent: null, conditional: true }
    expect(navSnapshotDiff(base(), changed)).toEqual([
      'nav id primary.home changed (surface, parent or condition)',
    ])
  })

  it('names an added and a removed surface', () => {
    const added = base()
    added.surfaces.push({ id: 'extra' })
    expect(navSnapshotDiff(base(), added)).toEqual(['surface extra is new'])
    expect(navSnapshotDiff(added, base())).toEqual(['surface extra is gone'])
  })
})

describe("PV's own native nav equals the committed snapshot (Story 68.10 AC-9c)", () => {
  it('has the same surfaces, native ids, parents and conditions as the snapshot', () => {
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as NavSnapshot
    expect(expected.ids.length).toBeGreaterThan(70)
    expect(navSnapshotDiff(expected, fromRegistry())).toEqual([])
  })
})
