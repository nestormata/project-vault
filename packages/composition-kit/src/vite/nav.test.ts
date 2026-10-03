// Story 68.7 AC-8: `pvNav()` resolves `virtual:pv-nav` to a re-export of the pack's materialized
// nav file, `export default {}` without one or against an older web-host, and fails closed without
// a lock.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLock, serializeLock, writeFileAtomic, type CompositionLock } from '../lock.js'
import { navModuleCode, pvNav, PV_NAV_MODULE, PV_NAV_PLUGIN_NAME } from './nav.js'

const roots: string[] = []
const NAV_FILE = 'src/lib/_cm/nav.ts'
const EMPTY = 'export default {}\n'
const VIRTUAL_ID = '\0virtual:pv-nav'
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function lockWith(nav: string | null, navIdsHost?: string[]): CompositionLock {
  return buildLock({
    tuple: {} as never,
    overrides: [],
    additions: [],
    removals: [],
    replacements: [],
    relocated: [],
    contributions: { hooks: {}, nav, theme: null, protectedPaths: null },
    injectionPointsUsed: [],
    injections: [],
    excludedPvTests: [],
    guardEntries: {},
    navIdsReferenced: [],
    ...(navIdsHost === undefined ? {} : { navIdsHost }),
    apiRouteOverrides: [],
    notes: [],
  })
}

describe('navModuleCode (Story 68.7 AC-8)', () => {
  it('re-exports the materialized nav file through $lib', () => {
    expect(navModuleCode(lockWith(NAV_FILE, ['primary.health']), '/app')).toBe(
      'export { default } from "$lib/_cm/nav.ts"\n'
    )
  })

  it('is an empty delta without a nav file, and against an older web-host (no navIdsHost)', () => {
    expect(navModuleCode(lockWith(null, []), '/app')).toBe(EMPTY)
    expect(navModuleCode(lockWith(NAV_FILE), '/app')).toBe(EMPTY)
  })
})

describe('pvNav() (Story 68.7 AC-8)', () => {
  function plugin(lock?: CompositionLock) {
    const root = mkdtempSync(join(tmpdir(), 'kit-pv-nav-'))
    roots.push(root)
    if (lock !== undefined)
      writeFileAtomic(join(root, 'composition.lock.json'), serializeLock(lock))
    const nav = pvNav({ appRoot: root })
    return {
      nav,
      resolveId: nav.resolveId as (id: string) => string | null,
      load: nav.load as (id: string) => string | null,
    }
  }

  it('is a pre plugin named for web-host’s empty provider and owns only virtual:pv-nav', () => {
    const { nav, resolveId, load } = plugin(lockWith(null, []))
    expect(nav.name).toBe(PV_NAV_PLUGIN_NAME)
    expect(nav.enforce).toBe('pre')
    expect(resolveId(PV_NAV_MODULE)).toBe(VIRTUAL_ID)
    expect(resolveId('virtual:pv-nav/x')).toBeNull()
    expect(load('\0virtual:other')).toBeNull()
    expect(load(VIRTUAL_ID)).toBe(EMPTY)
  })

  it('fails closed without a lock', () => {
    const { load } = plugin()
    expect(() => load(VIRTUAL_ID)).toThrow(
      /pvNav\(\): no composition.lock.json at .*run pv-compose/
    )
  })
})
