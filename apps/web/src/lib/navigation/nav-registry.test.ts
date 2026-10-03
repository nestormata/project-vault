// Story 68.7 AC-1: one registry of every nav surface and every PV item id; the builders and the
// registry are tied both ways, so an id cannot be emitted without being registered, nor registered
// without being emitted.
import { describe, expect, it } from 'vitest'
import { NAV_IDS, NAV_SURFACES, isNavId, navIdProblems, registryProblems } from './nav-registry.js'
import { SURFACE_ITEMS, surfaceItems } from './surfaces/index.js'
import type { NavItem } from './types.js'

function idsOf(items: readonly NavItem<never>[], parent: string): [string, string][] {
  return items.flatMap((item) => [
    [item.id, parent] as [string, string],
    ...idsOf(item.children ?? [], item.id),
  ])
}

/** Every id each builder emits (the full tree: `when` filtering happens after the delta). */
function emitted(): Map<string, { surface: string; parent: string }> {
  const out = new Map<string, { surface: string; parent: string }>()
  for (const surface of NAV_SURFACES) {
    for (const [id, parent] of idsOf(surfaceItems(surface.id) as never, surface.id)) {
      out.set(id, { surface: surface.id, parent })
    }
  }
  return out
}

describe('nav registry (Story 68.7 AC-1)', () => {
  it('registers the sixteen inventoried surfaces, each with its renderer file', () => {
    expect(NAV_SURFACES.map((surface) => surface.id)).toEqual([
      'primary',
      'project',
      'shell.brand',
      'shell.utility',
      'shell.mfa-banner',
      'account',
      'footer',
      'settings.index',
      'platform.index',
      'platform.settings.links',
      'settings.audit.links',
      'notifications.tabs',
      'breadcrumbs',
      'back',
      'error.nav',
      'auth.links',
    ])
    for (const surface of NAV_SURFACES) expect(surface.file).toMatch(/^src\/.+\.svelte$/)
  })

  it('has no registry problems: grammar, prefixes, collisions and parents all hold', () => {
    expect(registryProblems(NAV_SURFACES, NAV_IDS)).toEqual([])
    expect(NAV_IDS.length).toBeGreaterThan(70)
  })

  it('every builder id is registered (with its surface and parent) and every registered id is built', () => {
    const built = emitted()
    for (const [id, where] of built) {
      const entry = NAV_IDS.find((candidate) => candidate.id === id)
      expect(entry, `builder emitted unknown id ${id} (add it to nav-registry.ts)`).toBeDefined()
      expect(entry?.surface).toBe(where.surface)
      expect(entry?.parent ?? where.surface).toBe(where.parent)
    }
    for (const entry of NAV_IDS) {
      expect(built.has(entry.id), `registry id ${entry.id} is never produced`).toBe(true)
    }
    expect(Object.keys(SURFACE_ITEMS).sort()).toEqual(NAV_SURFACES.map((s) => s.id).sort())
  })

  it('marks exactly the PV items with a visibility condition as conditional', () => {
    const conditional = NAV_IDS.filter((entry) => entry.conditional).map((entry) => entry.id)
    expect(conditional.sort()).toEqual([
      'primary.extension-panel',
      'primary.platform',
      'project.endpoints',
    ])
    for (const surface of NAV_SURFACES) {
      for (const [id] of idsOf(surfaceItems(surface.id) as never, surface.id)) {
        const item = findItem(surfaceItems(surface.id) as never, id)
        expect(item?.when !== undefined, id).toBe(conditional.includes(id))
      }
    }
  })

  describe('integrity problems', () => {
    const surfaces = [{ id: 'primary', file: 'src/x.svelte', contextKeys: [] }]
    it('reports a builder or registry id that breaks the grammar', () => {
      expect(
        registryProblems(surfaces, [
          { id: 'primary.Bad', surface: 'primary', parent: null, conditional: false },
        ])
      ).toEqual(['nav id "primary.Bad" breaks the id grammar'])
    })
    it('reports a PV id that does not start with its surface id', () => {
      expect(
        registryProblems(surfaces, [
          { id: 'project.x', surface: 'primary', parent: null, conditional: false },
        ])
      ).toEqual(['nav id "project.x" must start with its surface id "primary."'])
    })
    it('reports two ids that collide, in any two surfaces', () => {
      expect(
        registryProblems(
          [...surfaces, { id: 'project', file: 'src/y.svelte', contextKeys: [] }],
          [
            { id: 'primary.a', surface: 'primary', parent: null, conditional: false },
            { id: 'primary.a', surface: 'primary', parent: null, conditional: false },
          ]
        )
      ).toEqual(['nav id "primary.a" is declared twice'])
    })
    it('reports a parent that names a missing id, and an unknown surface', () => {
      expect(
        registryProblems(surfaces, [
          { id: 'primary.a', surface: 'primary', parent: 'primary.nope', conditional: false },
          { id: 'ghost.a', surface: 'ghost', parent: null, conditional: false },
        ])
      ).toEqual([
        'nav id "primary.a" names a missing parent "primary.nope"',
        'nav id "ghost.a" names an unknown surface "ghost"',
      ])
    })
  })

  describe('id grammar (linear helper, no nested-quantifier regex)', () => {
    it.each([
      ['primary', true],
      ['primary.dashboard', true],
      ['settings.index.sso-domains', true],
      ['cm.billing-2', true],
      ['a-b.c-d.e', true],
      ['', false],
      ['Primary', false],
      ['primary.', false],
      ['.primary', false],
      ['primary..x', false],
      ['primary.-x', false],
      ['primary.x-', false],
      ['primary.x--y', false],
      ['__proto__', false],
      ['constructor', false],
      ['cm.prototype', false],
      ['cm.constructors', true],
      ['primary x', false],
    ])('%j -> %s', (id, valid) => {
      expect(isNavId(id)).toBe(valid)
    })
    it('rejects non-strings', () => {
      expect(isNavId(42)).toBe(false)
      expect(navIdProblems(undefined)).toEqual(['nav id must be a string'])
    })
    it('checks a very long id in linear time', () => {
      const long = `${'a-'.repeat(50_000)}a`
      const started = performance.now()
      expect(isNavId(long)).toBe(true)
      expect(isNavId(`${long}-`)).toBe(false)
      expect(performance.now() - started).toBeLessThan(200)
    })
  })
})

function findItem(items: readonly NavItem<never>[], id: string): NavItem<never> | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const found = findItem(item.children ?? [], id)
    if (found !== undefined) return found
  }
  return undefined
}
