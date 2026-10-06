// Story 68.10 AC-4: unit tests of the shipped monolithic-region guard, co-located with the web
// package so its own coverage run measures apps/web/guards/{monolithic-region,region-markup,
// svelte-files}.ts. The repository CLI, registry-marker and PV-tree tests stay in
// scripts/check-monolithic-regions.test.ts. Fixtures are written to temp trees, never under `src/`.
import { describe, expect, it } from 'vitest'
import {
  newScanContext,
  runGuard,
  scanMonolithicRegions,
  scanMonolithicRegionsTree,
} from '../guards/monolithic-region.ts'
import { parseMarkup } from '../guards/region-markup.ts'
// The repository's shared fixture helpers (this test is PV-repository-only, never shipped).
import { useFixtureRoots, writeFixture } from '../../../scripts/lib/fixture-test-helpers.ts'

const makeRoot = useFixtureRoots('monolithic-region-', ['src'])

const CM_FILE = 'src/lib/_cm/a.svelte'
const MONOLITHIC = '<!-- @region a -->\n<div>plain</div>\n'
const IMPORT_TILE = `<script>\n  import Tile from './Tile.svelte'\n</script>\n`
const messages = (source: string): string[] =>
  scanMonolithicRegions(source, 'x.svelte').findings.map((f) => f.message)

describe('monolithic-region: the rule (AC-4.2)', () => {
  it('passes a region that is a component', () => {
    const result = scanMonolithicRegions(
      `${IMPORT_TILE}<!-- @region tiles -->\n<Tile {project} />`,
      'x.svelte'
    )
    expect(result).toEqual({ regions: 1, findings: [] })
  })

  it('passes a region that wraps an element holding a component and a point', () => {
    expect(
      messages(
        `${IMPORT_TILE}<!-- @region tiles -->\n<div><Tile /><InjectionPoint name="a.b.c" /></div>`
      )
    ).toEqual([])
  })

  it('fails a bare div holding only text and an injection point (non-vacuity)', () => {
    const found = scanMonolithicRegions(
      '<!-- @region tiles -->\n<div>hello <InjectionPoint name="a.b.c" /></div>',
      'x.svelte'
    ).findings
    expect(found).toEqual([
      {
        line: 1,
        message:
          '@region "tiles" is a monolithic region (neither a component nor does it contain one)',
      },
    ])
  })

  it('passes once the same region is fixed by extracting a component', () => {
    const broken = '<!-- @region tiles -->\n<div><p>plain</p></div>'
    expect(messages(broken)).toHaveLength(1)
    expect(messages(`${IMPORT_TILE}<!-- @region tiles -->\n<div><Tile /></div>`)).toEqual([])
  })

  it('accepts a component imported under an alias and a namespace member', () => {
    expect(
      messages(
        `<script>\n  import { default as Alias } from './Tile.svelte'\n</script>\n<!-- @region a -->\n<Alias />`
      )
    ).toEqual([])
    expect(
      messages(
        `<script>\n  import * as Ui from './Tile.svelte'\n</script>\n<!-- @region a -->\n<Ui.Tile />`
      )
    ).toEqual([])
  })

  it('accepts a component imported from a node_modules .svelte file', () => {
    expect(
      messages(
        `<script>\n  import Tile from 'some-lib/Tile.svelte'\n</script>\n<!-- @region a -->\n<Tile />`
      )
    ).toEqual([])
  })

  it('accepts a component imported in a module script', () => {
    expect(
      messages(
        `<script module>\n  import Tile from './Tile.svelte'\n</script>\n<!-- @region a -->\n<Tile />`
      )
    ).toEqual([])
  })

  it('counts a dynamic <svelte:component> and a {@render} marked node as components', () => {
    expect(messages('<!-- @region a -->\n<svelte:component this={thing} />')).toEqual([])
    expect(messages('<!-- @region a -->\n{@render children()}')).toEqual([])
  })

  it('handles regions inside {#if} and {#each} blocks', () => {
    const inside = `${IMPORT_TILE}{#if ok}\n<!-- @region a -->\n<Tile />\n{/if}\n{#each list as item}\n<!-- @region b -->\n<div>plain</div>\n{/each}`
    expect(messages(inside)).toEqual([
      '@region "b" is a monolithic region (neither a component nor does it contain one)',
    ])
  })

  it('checks two markers in a row independently', () => {
    const source = `${IMPORT_TILE}<!-- @region one -->\n<!-- @region two -->\n<Tile />`
    // Marker one is followed by the comment `two` (a non-blank sibling), which is no component.
    expect(messages(source)).toEqual([
      '@region "one" is a monolithic region (neither a component nor does it contain one)',
    ])
  })

  it('reports a marker with nothing after it as malformed, like 68-4 does', () => {
    const found = scanMonolithicRegions('<div></div>\n<!-- @region tail -->', 'x.svelte').findings
    expect(found.map((f) => f.message)).toEqual([
      '@region comment is not followed by an element or block',
    ])
  })
})

describe('monolithic-region: evasion cases fail (AC-4.9)', () => {
  const monolithic = (name: string) =>
    `@region "${name}" is a monolithic region (neither a component nor does it contain one)`

  it('does not count a component only named in a comment or a string', () => {
    expect(
      messages(`${IMPORT_TILE}<!-- @region a -->\n<div title="<Tile />"><!-- <Tile /> --></div>`)
    ).toEqual([monolithic('a')])
  })

  it('does not count a component imported but not used inside the region', () => {
    expect(messages(`${IMPORT_TILE}<Tile />\n<!-- @region a -->\n<div>plain</div>`)).toEqual([
      monolithic('a'),
    ])
  })

  it('does not count a capitalized tag bound to a local const or snippet', () => {
    expect(
      messages(
        `<script>\n  const Local = makeThing()\n</script>\n<!-- @region a -->\n<div><Local /></div>`
      )
    ).toEqual([monolithic('a')])
    expect(
      messages(`{#snippet Piece()}<p>x</p>{/snippet}\n<!-- @region a -->\n<div><Piece /></div>`)
    ).toEqual([monolithic('a')])
  })

  it('does not count a component imported from a .ts module', () => {
    expect(
      messages(
        `<script>\n  import Tile from './tile.ts'\n</script>\n<!-- @region a -->\n<div><Tile /></div>`
      )
    ).toEqual([monolithic('a')])
  })

  it('does not count InjectionPoint, even imported from a .svelte file or aliased', () => {
    expect(
      messages(
        `<script>\n  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n<!-- @region a -->\n<InjectionPoint name="a.b.c" />`
      )
    ).toEqual([monolithic('a')])
    expect(
      messages(
        `<script>\n  import Point from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n<!-- @region a -->\n<div><Point name="a.b.c" /></div>`
      )
    ).toEqual([monolithic('a')])
  })

  it('treats both marker spellings the same', () => {
    // `<!--@region x-->` has the data "@region x", which the shared 68-4 regex accepts: same verdict.
    expect(messages('<!--@region x-->\n<div>p</div>')).toEqual([
      '@region "x" is a monolithic region (neither a component nor does it contain one)',
    ])
    expect(messages('<!--@region x-->\n<div>p</div>')).toEqual(
      messages('<!-- @region x -->\n<div>p</div>')
    )
  })

  it('does not read a marker inside <script> or <style> as a region', () => {
    const source = `<script>\n  // <!-- @region a -->\n  const s = '<!-- @region b -->'\n</script>\n<style>\n/* <!-- @region c --> */\n</style>\n<div></div>`
    expect(scanMonolithicRegions(source, 'x.svelte')).toEqual({ regions: 0, findings: [] })
  })

  it('passes a wrapper component that itself holds plain HTML (recorded limit)', () => {
    expect(messages(`${IMPORT_TILE}<!-- @region a -->\n<Tile><p>plain</p></Tile>`)).toEqual([])
  })

  it('reports a file the svelte compiler cannot parse, never a silent skip (fail closed)', () => {
    const result = scanMonolithicRegions('<!-- @region a -->\n<div>', 'broken.svelte')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.message).toContain('could not be parsed')
  })
})

describe('monolithic-region: tree scan, provenance exemption and the shipped contract', () => {
  it('scans PV-originated files and reports file:line findings', () => {
    const root = makeRoot()
    writeFixture(root, 'src/lib/a.svelte', MONOLITHIC)
    const result = scanMonolithicRegionsTree(root)
    expect(result.files).toBe(1)
    expect(result.regions).toBe(1)
    expect(result.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['src/lib/a.svelte:1'])
  })

  it('exempts files the lock records as CM-originated and only those', () => {
    const root = makeRoot()
    writeFixture(root, CM_FILE, MONOLITHIC)
    writeFixture(root, 'src/lib/pv.svelte', MONOLITHIC)
    const result = scanMonolithicRegionsTree(root, [CM_FILE])
    expect(result.findings.map((f) => f.file)).toEqual(['src/lib/pv.svelte'])
  })

  it('applies the same verdict to the same markup under a CM path without a lock', () => {
    const root = makeRoot()
    writeFixture(root, CM_FILE, MONOLITHIC)
    expect(scanMonolithicRegionsTree(root).findings).toHaveLength(1)
  })

  it('skips test support and test files like the 68-4 coverage guard', () => {
    const root = makeRoot()
    writeFixture(root, 'src/lib/test/Fixture.svelte', MONOLITHIC)
    expect(scanMonolithicRegionsTree(root)).toEqual({
      files: 0,
      exempted: 0,
      regions: 0,
      routeRegions: 0,
      topLevelUses: 0,
      topLevelUsesInRegion: 0,
      findings: [],
    })
  })

  it('runGuard follows the script-guard contract and takes the exempt list as a second argument', () => {
    const root = makeRoot()
    writeFixture(root, CM_FILE, MONOLITHIC)
    expect(runGuard(root)).toHaveLength(1)
    expect(runGuard(root)[0]?.message).toContain('monolithic region')
    expect(runGuard(root, [CM_FILE])).toEqual([])
  })
})

describe('monolithic-region: looking through a component use (R3)', () => {
  const root = '/app'
  const USE = `${IMPORT_TILE}<Tile />`
  const scanWith = (read: (path: string) => string | undefined): string[] =>
    scanMonolithicRegions(
      USE,
      '/app/src/routes/x/+page.svelte',
      newScanContext(root, read)
    ).findings.map((f) => f.message)

  it('reads nothing by default, so a use is not looked through', () => {
    expect(newScanContext(root).read('/app/src/lib/Tile.svelte')).toBeUndefined()
  })

  it('treats a component whose source cannot be read as holding no region', () => {
    expect(scanWith(() => undefined)).toHaveLength(1)
  })

  it('treats a component whose source cannot be parsed as holding no region', () => {
    expect(scanWith(() => '{#if broken}')).toHaveLength(1)
  })

  it('counts a use of a component that carries its own region', () => {
    expect(scanWith(() => '<!-- @region t -->\n<p>x</p>')).toEqual([])
  })
})

describe('region-markup: points the template never renders (69-6)', () => {
  const point = '<InjectionPoint name="a.b.c" />'
  const parse = (markup: string) => parseMarkup(markup, 'x.svelte')

  it('puts a point in an unrendered snippet among the dead points', () => {
    const parsed = parse(`{#snippet row()}${point}{/snippet}`)
    expect(parsed.points).toEqual([])
    expect(parsed.deadPoints.map((d) => d.reason)).toEqual([
      'inside {#snippet row}, which is never rendered',
    ])
  })

  it('keeps a point in a snippet the same file renders', () => {
    const parsed = parse(`{#snippet row()}${point}{/snippet}\n{@render row()}`)
    expect(parsed.points).toHaveLength(1)
    expect(parsed.deadPoints).toEqual([])
  })

  it('keeps a point in a snippet rendered through an optional call', () => {
    const parsed = parse(`{#snippet row()}${point}{/snippet}\n{@render row?.()}`)
    expect(parsed.points).toHaveLength(1)
  })

  it('keeps a point in a snippet a component receives as a prop', () => {
    const parsed = parse(`<Panel>{#snippet row()}${point}{/snippet}</Panel>`)
    expect(parsed.points).toHaveLength(1)
  })

  it('flags a point in the branch of a literal {#if} that never renders', () => {
    expect(parse(`{#if false}${point}{/if}`).deadPoints).toHaveLength(1)
    expect(parse(`{#if true}<p>x</p>{:else}${point}{/if}`).deadPoints).toHaveLength(1)
    expect(parse(`{#if true}${point}{/if}`).points).toHaveLength(1)
  })
})
