// Story 68.10 AC-4: the monolithic-region guard (rule and evasion unit tests live in
// apps/web/config/monolithic-region.test.ts). A region marked `<!-- @region <name> -->` in a
// PV-originated `.svelte` file must be a component or contain one (an imported `.svelte` binding, a
// `<svelte:component>` or a `{@render}`), so it can be replaced individually through M4.
// `<InjectionPoint>` never counts. Fixtures are written to temp trees, never committed under `src/`.
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanMonolithicRegionsTree } from '../apps/web/guards/monolithic-region.js'
import { guardMarker } from './lib/web-host/guard-registry.js'
import { scanMarkup } from './lib/injection-point-coverage.js'
import { run } from './check-monolithic-regions.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

// The shipped guard sources, read through Vite (no dynamic fs path in the test).
const GUARD_SOURCES = new Map(
  Object.entries(
    import.meta.glob('../apps/web/guards/*.ts', { query: '?raw', import: 'default', eager: true })
  ).map(([key, text]) => [key.slice('../apps/web/'.length), String(text)] as const)
)

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(repositoryRoot, 'apps/web')
/** 4 on the project page, 1 in the project nav, 9 on the dashboard (Story 69.1). */
const REGIONS_ADDED_BY_69_1 = 14
// Story 69.2: the credential detail page's regions (13).
const REGIONS_ADDED_BY_69_2 = 13
// Story 69.4: the settings audit, settings notifications and project members pages (17).
const REGIONS_ADDED_BY_69_4 = 17
// Story 69.3: the endpoint list/new/detail, status page admin and public status regions.
const REGIONS_ADDED_BY_69_3 = 22
const makeRoot = useFixtureRoots('monolithic-region-', ['src'])

const PV_FILE = 'src/a.svelte'
const MONOLITHIC = '<!-- @region a -->\n<div>plain</div>\n'
const IMPORT_TILE = `<script>\n  import Tile from './Tile.svelte'\n</script>\n`

describe('monolithic-region: the shipped contract', () => {
  it('carries the registry marker with scope pv-originated-only and no suppression syntax', () => {
    const code = GUARD_SOURCES.get('guards/monolithic-region.ts') ?? ''
    expect(code).not.toBe('')
    expect(guardMarker(code)).toEqual({
      id: 'monolithic-region',
      scope: 'pv-originated-only',
      subjects: [],
    })
    expect(code).not.toMatch(/@region-ignore/)
  })

  it('imports only node: modules, svelte/compiler and its sibling walker (ships standalone)', () => {
    for (const file of [
      'guards/monolithic-region.ts',
      'guards/region-markup.ts',
      'guards/svelte-files.ts',
    ]) {
      const code = GUARD_SOURCES.get(file) ?? ''
      expect(code, file).not.toBe('')
      const specifiers = [...code.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
      for (const specifier of specifiers) {
        expect(
          specifier?.startsWith('node:') === true ||
            specifier === 'svelte/compiler' ||
            specifier?.startsWith('./') === true,
          `${file} imports ${specifier}`
        ).toBe(true)
      }
    }
  })
})

describe("monolithic-region on PV's own tree (AC-4.6)", () => {
  it('is non-failing today and scans exactly the files the 68-4 guard scans', () => {
    const own = scanMonolithicRegionsTree(WEB)
    expect(own.findings).toEqual([])
    expect(own.files).toBeGreaterThan(50)
    // The 68-4 coverage guard scans the same `.svelte` set; a silent scan of nothing cannot pass.
    const coverageFiles = scanSvelteCount()
    expect(own.files).toBe(coverageFiles)
  })

  // Story 69.1 AC-3: the first story to add regions to PV's tree. A guard that counted none would
  // stay green with every marker deleted, so the count is pinned from below.
  it('counts at least the regions Story 69.1 added, all replaceable components', () => {
    const own = scanMonolithicRegionsTree(WEB)
    expect(own.regions).toBeGreaterThanOrEqual(REGIONS_ADDED_BY_69_1 + REGIONS_ADDED_BY_69_3)
    expect(own.findings).toEqual([])
  })

  // Story 69.2 AC-1/AC-8: the credential page adds 13 regions on top of 69.1's 14.
  it('counts the regions of Stories 69.1 to 69.4 together, all replaceable components', () => {
    const own = scanMonolithicRegionsTree(WEB)
    expect(own.regions).toBeGreaterThanOrEqual(
      REGIONS_ADDED_BY_69_1 + REGIONS_ADDED_BY_69_2 + REGIONS_ADDED_BY_69_3 + REGIONS_ADDED_BY_69_4
    )
    expect(own.findings).toEqual([])
  })

  // Story 69.5 AC-3: PV's route files carry markers of their own and pass R1/R2, so the guard is
  // not vacuous on routes: every route file is clean and the markers in route files are counted
  // apart from the `$lib` ones. (The audit table also counts regions that live in the components a
  // route imports, so its row count is larger than this number by design.)
  it('counts the regions marked in route files separately, with no unmarked or fat shell', () => {
    const own = scanMonolithicRegionsTree(WEB)
    expect(own.routeRegions).toBeGreaterThan(80)
    expect(own.routeRegions).toBeLessThan(own.regions)
    expect(own.findings).toEqual([])
  })
})

describe('check-monolithic-regions CLI (AC-4.5)', () => {
  const capture = (args: string[]) => {
    let out = ''
    let err = ''
    const code = run(args, {
      out: (text) => (out += text),
      err: (text) => (err += text),
    })
    return { code, out, err }
  }

  it('prints the OK line with file and region counts and exits 0', () => {
    const root = makeRoot()
    writeFixture(root, PV_FILE, `${IMPORT_TILE}<!-- @region a -->\n<Tile />`)
    const result = capture(['--web', root])
    expect(result.code).toBe(0)
    expect(result.out).toBe('check-monolithic-regions: scanned 1 files, 1 regions — OK\n')
  })

  it('prints one file:line: message per finding and exits 1', () => {
    const root = makeRoot()
    writeFixture(root, PV_FILE, MONOLITHIC)
    const result = capture(['--web', root])
    expect(result.code).toBe(1)
    expect(result.err).toContain(
      'src/a.svelte:1: @region "a" is a monolithic region (neither a component nor does it contain one)'
    )
  })

  it('--lock exempts the files the lock records as CM-originated (overrides, additions, materialized)', () => {
    const root = makeRoot()
    writeFixture(root, 'src/o.svelte', MONOLITHIC)
    writeFixture(root, 'src/ad.svelte', MONOLITHIC)
    writeFixture(root, 'src/m.svelte', MONOLITHIC)
    writeFixture(
      root,
      'composition.lock.json',
      JSON.stringify({
        overrides: [{ path: 'src/o.svelte' }],
        additions: [{ path: 'src/ad.svelte' }],
        materialized: [{ path: 'src/m.svelte' }],
      })
    )
    expect(capture(['--web', root, '--lock', join(root, 'composition.lock.json')]).code).toBe(0)
  })

  it('fails when --lock names a missing file', () => {
    const root = makeRoot()
    writeFixture(root, PV_FILE, '<div></div>')
    expect(capture(['--web', root, '--lock', join(root, 'nope.json')]).code).toBe(1)
  })

  it('fails closed when it scans no files (a guard that matches nothing is not a pass)', () => {
    const result = capture(['--web', makeRoot()])
    expect(result.code).toBe(1)
    expect(result.err).toContain('scanned 0 files')
  })
})

function scanSvelteCount(): number {
  // The 68-4 coverage guard's own `.svelte` walk (same skip rules), counted without its findings.
  return scanMarkup(WEB, new Set(), []).length
}
