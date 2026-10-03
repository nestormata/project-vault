// Story 68.10 AC-4: the monolithic-region guard. A region marked `<!-- @region <name> -->` in a
// PV-originated `.svelte` file must be a component or contain one (an imported `.svelte` binding, a
// `<svelte:component>` or a `{@render}`), so it can be replaced individually through M4.
// `<InjectionPoint>` never counts. Fixtures are written to temp trees, never committed under `src/`.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  runGuard,
  scanMonolithicRegions,
  scanMonolithicRegionsTree,
} from '../apps/web/guards/monolithic-region.js'
import { guardMarker } from './lib/web-host/guard-registry.js'
import { scanMarkup } from './lib/injection-point-coverage.js'
import { run } from './check-monolithic-regions.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(repositoryRoot, 'apps/web')
const makeRoot = useFixtureRoots('monolithic-region-', ['src'])

const CM_FILE = 'src/lib/_cm/a.svelte'
const PV_FILE = 'src/a.svelte'
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
    writeFixture(root, 'src/routes/+page.svelte', MONOLITHIC)
    const result = scanMonolithicRegionsTree(root)
    expect(result.files).toBe(1)
    expect(result.regions).toBe(1)
    expect(result.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['src/routes/+page.svelte:1'])
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

  it('carries the registry marker with scope pv-originated-only and no suppression syntax', () => {
    const code = readFileSync(join(WEB, 'guards/monolithic-region.ts'), 'utf8')
    expect(guardMarker(code)).toEqual({
      id: 'monolithic-region',
      scope: 'pv-originated-only',
      subjects: [],
    })
    expect(code).not.toMatch(/@region-ignore/)
  })

  it('imports only node: modules, svelte/compiler and its sibling walker (ships standalone)', () => {
    for (const file of ['guards/monolithic-region.ts', 'guards/region-markup.ts']) {
      const code = readFileSync(join(WEB, file), 'utf8')
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
