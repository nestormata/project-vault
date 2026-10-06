// Story 69.5 AC-3: the route-file rules of the shipped monolithic-region guard. R1 (no unmarked
// top-level content in a route file) and R2 (a marked region of a route file is a thin shell) apply
// to `src/routes/**/+page|+layout|+error.svelte` only; the rule tests for the shared marker rule live
// in monolithic-region.test.ts. Fixtures are written to temp trees, never under `src/`.
import { describe, expect, it } from 'vitest'
import { scanMonolithicRegions, scanMonolithicRegionsTree } from '../guards/monolithic-region.ts'
import { parseMarkup } from '../guards/region-markup.ts'
import { useFixtureRoots, writeFixture } from '../../../scripts/lib/fixture-test-helpers.ts'

const makeRoot = useFixtureRoots('monolithic-region-routes-', ['src'])

const UNMARKED_DIV = 'unmarked top-level content: <div> (put it in a region component)'
const PLAIN_DIV = '<div>plain</div>'
const TREE_ROUTE = 'src/routes/(app)/things/+page.svelte'
const ROUTE = 'apps/web/src/routes/(app)/things/+page.svelte'
const SCRIPT = `<script>\n  import Tile from '$lib/components/Tile.svelte'\n  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'\n</script>\n`
const LIB_FILE = 'apps/web/src/lib/components/A.svelte'
const MARKED = '<!-- @region a.b.c -->\n<Tile><InjectionPoint name="a.b.c" /></Tile>'
const CM_ROUTE = 'src/routes/cm/+page.svelte'
const OK = '<!-- @region ok.row.shell -->\n<Tile><InjectionPoint name="ok.row.shell" /></Tile>'
const scan = (markup: string, file = ROUTE) => scanMonolithicRegions(`${SCRIPT}${markup}`, file)
const messages = (markup: string, file = ROUTE): string[] =>
  scan(markup, file).findings.map((finding) => finding.message)

describe('route rules: the canonical region shell', () => {
  const SHELL = `<!-- @region things.list.table -->
<section class="space-y-4"><InjectionPoint name="things.list.table" /><Tile /></section>`

  it('passes both the 68-4 point rule and the monolithic rule', () => {
    expect(parseMarkup(`${SCRIPT}${SHELL}`, ROUTE).regionProblems).toEqual([])
    expect(scan(SHELL).findings).toEqual([])
    expect(scan(SHELL).regions).toBe(1)
  })

  it('passes a shell holding two components and a point', () => {
    expect(
      messages(
        `<!-- @region a.b.c -->\n<div class="grid"><Tile /><InjectionPoint name="a.b.c" /><Tile /></div>`
      )
    ).toEqual([])
  })

  it('passes a root {#if} around the shell and around a branch shell', () => {
    expect(
      messages(
        `{#if data.ok}\n<!-- @region a.b.c -->\n<div><InjectionPoint name="a.b.c" /><Tile /></div>\n{:else}\n<!-- @region a.b.d -->\n<div><InjectionPoint name="a.b.d" /><Tile /></div>\n{/if}`
      )
    ).toEqual([])
  })
})

describe('route rules: R1 unmarked top-level content', () => {
  it('fails a bare top-level div and names the node and line', () => {
    const found = scan(`${OK}\n<div class="x">hello</div>`).findings
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toBe(UNMARKED_DIV)
    expect(found[0]?.line).toBe(SCRIPT.split('\n').length + 2)
  })

  it('fails a route whose only content is injection points (no regions)', () => {
    const found = messages(
      '<InjectionPoint name="a.b.before" />\n<InjectionPoint name="a.b.header.actions" />\n<InjectionPoint name="a.b.after" />'
    )
    expect(found).toEqual([
      'route file has no regions: it holds nothing but injection points (points are not content)',
    ])
  })

  it('fails a bare section inside a root {#if} branch; a marker before the node passes', () => {
    expect(messages(`{#if data.a}\n<section>x</section>\n{/if}\n${OK}`)).toEqual([
      'unmarked top-level content: <section> (put it in a region component)',
    ])
    expect(
      messages(
        '{#if data.a}\n<!-- @region a.b.c -->\n<section><InjectionPoint name="a.b.c" /><Tile /></section>\n{/if}'
      )
    ).toEqual([])
  })

  it('treats a marked node as covered', () => {
    expect(messages(OK)).toEqual([])
  })

  it('ignores head, window, comments, const tags and blank text', () => {
    expect(
      messages(
        `<svelte:head><title>x</title></svelte:head>\n<svelte:window onkeydown={f} />\n<!-- a note -->\n{@const y = 1}\n${OK}`
      )
    ).toEqual([])
  })

  it('checks a top-level {#snippet} body like a branch, so a snippet cannot hide page markup', () => {
    expect(
      messages(
        '{#snippet row(x)}<li>{x}</li>{/snippet}\n<!-- @region a.b.c -->\n<section><Tile /></section>'
      )
    ).toEqual(['unmarked top-level content: <li> (put it in a region component)'])
  })

  it('lets a layout wrapper through when every child is covered, fails it with a bare <p>', () => {
    expect(
      messages(
        '<div class="space-y-6">\n<!-- @region a.b.c -->\n<div><InjectionPoint name="a.b.c" /><Tile /></div>\n<!-- @region a.b.d -->\n<Tile><InjectionPoint name="a.b.d" /></Tile>\n</div>'
      )
    ).toEqual([])
    expect(messages(`<div class="space-y-6">\n${OK}\n<p>stray</p>\n</div>`)).toEqual([
      'unmarked top-level content: <p> (put it in a region component)',
    ])
  })

  it('does not let a wrapper with an event handler hide content', () => {
    expect(messages('<div onclick={go}><Tile /></div>')).toEqual([UNMARKED_DIV])
  })

  it('fails top-level text and an expression tag', () => {
    expect(messages(`${OK}\nhello`)).toEqual([
      'unmarked top-level content: text (put it in a region component)',
    ])
    expect(messages(`${OK}\n{data.title}`)).toEqual([
      'unmarked top-level content: {expression} (put it in a region component)',
    ])
  })

  it('does not run on a $lib component, a non-route name or a nested +page elsewhere', () => {
    expect(messages(PLAIN_DIV, LIB_FILE)).toEqual([])
    expect(messages(PLAIN_DIV, 'x.svelte')).toEqual([])
    expect(messages(PLAIN_DIV, 'apps/web/src/lib/routes-helper/+page.svelte')).toEqual([])
  })

  it('reports an unparseable route file (fail closed)', () => {
    expect(messages('<div>', ROUTE)[0]).toMatch(/could not be parsed/)
  })

  it('reports a marker with trailing text or another casing, never silently ignores it', () => {
    expect(messages('<!-- @region -->\n<Tile />')[0]).toMatch(/must be written/)
    expect(messages('<!-- @region a b -->\n<Tile />')[0]).toMatch(/must be written/)
    expect(messages('<!-- @Region a.b.c -->\n<div>stray</div>')).toEqual([UNMARKED_DIV])
  })
})

describe('route rules: R3 top-level component use outside a region', () => {
  const R3 = (what: string): string =>
    `unmarked top-level component use: ${what} (wrap it in a region component with a registered point)`

  it('fails a bare component use and names it', () => {
    expect(messages('<Tile />')).toEqual([R3('<Tile />')])
  })

  it('counts a member component, <svelte:component> and a {@render} as uses', () => {
    const script = `<script>\n  import Tile from '$lib/components/Tile.svelte'\n</script>\n`
    const found = scanMonolithicRegions(
      `${script}<Tile.Sub />\n<svelte:component this={Tile} />\n{@render children()}`,
      ROUTE
    ).findings.map((finding) => finding.message)
    expect(found).toEqual([
      R3('<Tile.Sub />'),
      R3('<svelte:component>'),
      R3('{@render children()}'),
    ])
  })

  it('finds a use inside a layout wrapper, a root {#if} and a root {#snippet}', () => {
    expect(messages('<div class="space-y-6"><Tile /></div>')).toEqual([R3('<Tile />')])
    expect(messages('{#if data.a}<Tile />{/if}')).toEqual([R3('<Tile />')])
    expect(messages('{#snippet row()}<Tile />{/snippet}')).toEqual([R3('<Tile />')])
  })

  it('passes a use that is the marked region, in a wrapper, an {#if} branch and a boundary', () => {
    const marked = MARKED
    expect(messages(marked)).toEqual([])
    expect(messages(`<div class="x">${marked}</div>`)).toEqual([])
    expect(messages(`{#if data.a}\n${marked}\n{/if}`)).toEqual([])
    expect(messages(`<svelte:boundary>\n${marked}\n</svelte:boundary>`)).toEqual([])
  })

  it('does not count the standard points, head, window or a marked {@render} wrapper as uses', () => {
    expect(
      messages(
        '<InjectionPoint name="a.b.before" />\n<svelte:head><title>x</title></svelte:head>\n<!-- @region a.b.c -->\n<Tile><InjectionPoint name="a.b.c" /></Tile>\n<InjectionPoint name="a.b.after" />'
      )
    ).toEqual([])
  })

  it('does not let an element with attributes or a handler hide a use (red-team j)', () => {
    expect(messages('<div class="x" onclick={go}><Tile /></div>')).toEqual([UNMARKED_DIV])
  })

  it('fails when the marker drifts one node away from its component (red-team h)', () => {
    const found = messages(
      '<!-- @region a.b.c -->\n<div class="x"><InjectionPoint name="a.b.c" /></div>\n<Tile />'
    )
    expect(found).toEqual([
      '@region "a.b.c" is a monolithic region (neither a component nor does it contain one)',
      R3('<Tile />'),
    ])
  })

  it('does not run on a $lib component (a component may hold plain uses)', () => {
    expect(messages('<Tile />', LIB_FILE)).toEqual([])
  })

  it('flags a region that is only a {@render} (a render-only region has no component to replace)', () => {
    const found = messages('<!-- @region a.b.c -->\n{@render children()}')
    expect(found).toEqual(['@region "a.b.c" is only a {@render}: it holds no component of its own'])
  })

  it('reports how many top-level uses a route file has and how many sit in a region', () => {
    const marked = MARKED
    expect(scan(`${marked}\n<Tile />`)).toMatchObject({ uses: 2, usesInRegion: 1 })
    expect(scan(marked)).toMatchObject({ uses: 1, usesInRegion: 1 })
    expect(scan('<Tile />\n<Tile />')).toMatchObject({ uses: 2, usesInRegion: 0 })
  })

  it('totals the use counts over a tree and leaves a lock-exempt file out of them', () => {
    const root = makeRoot()
    writeFixture(
      root,
      TREE_ROUTE,
      `${SCRIPT}<!-- @region a.b.c -->\n<Tile><InjectionPoint name="a.b.c" /></Tile>\n<Tile />\n`
    )
    writeFixture(root, CM_ROUTE, `${SCRIPT}<Tile />\n`)
    const result = scanMonolithicRegionsTree(root, [CM_ROUTE])
    expect(result).toMatchObject({ topLevelUses: 2, topLevelUsesInRegion: 1, exempted: 1 })
  })
})

describe('route rules: R2 thin region shell', () => {
  it('fails inline text inside a marked shell', () => {
    expect(
      messages(
        '<!-- @region a.b.c -->\n<section><InjectionPoint name="a.b.c" /><Tile /><p>inline</p></section>'
      )
    ).toEqual([
      '@region "a.b.c" is not a thin shell: <p> holds markup that belongs in its component',
    ])
  })

  it('fails a form control, a handler and a bind inside a shell', () => {
    for (const inline of [
      '<input name="x" />',
      '<button>x</button>',
      '<div onclick={go}><Tile /></div>',
      '<div bind:this={el}><Tile /></div>',
    ]) {
      const found = messages(
        `<!-- @region a.b.c -->\n<section><InjectionPoint name="a.b.c" /><Tile />${inline}</section>`
      )
      expect(found, inline).toHaveLength(1)
      expect(found[0], inline).toMatch(/is not a thin shell/)
    }
  })

  it('fails an expression tag and a leaf element in a shell', () => {
    expect(
      messages(
        '<!-- @region a.b.c -->\n<section><Tile />{data.title}<InjectionPoint name="a.b.c" /></section>'
      )
    ).toHaveLength(1)
    expect(
      messages(
        '<!-- @region a.b.c -->\n<section><Tile /><hr /><InjectionPoint name="a.b.c" /></section>'
      )
    ).toHaveLength(1)
  })

  it('passes {#if}/{#each}/{#key} blocks around components, points and renders inside a shell', () => {
    expect(
      messages(
        '<!-- @region a.b.c -->\n<section>{#if data.a}<Tile />{:else}<Tile />{/if}{#each data.rows as row (row.id)}<Tile {row} />{/each}{#key data.id}{@render children()}{/key}<InjectionPoint name="a.b.c" /></section>'
      )
    ).toEqual([])
  })

  it('fails inline markup passed as children of a component inside a shell, passes a point child', () => {
    expect(messages('<!-- @region a.b.c -->\n<Tile><h1>Big</h1><p>text</p></Tile>')[0]).toMatch(
      /is not a thin shell: <h1>/
    )
    expect(
      messages('<!-- @region a.b.c -->\n<Tile><InjectionPoint name="a.b.c" /></Tile>')
    ).toEqual([])
  })

  it('does not run R2 on a $lib component', () => {
    expect(
      messages('<!-- @region a.b.c -->\n<section><Tile /><p>inline</p></section>', LIB_FILE)
    ).toEqual([])
  })
})

describe('route rules: tree scan', () => {
  it('reports routeRegions separately from the whole-tree regions count', () => {
    const root = makeRoot()
    const component = `${SCRIPT}<!-- @region a.b.lib -->\n<div><Tile /><InjectionPoint name="a.b.lib" /></div>\n`
    writeFixture(root, 'src/lib/components/A.svelte', component)
    writeFixture(
      root,
      TREE_ROUTE,
      `${SCRIPT}<!-- @region a.b.c -->\n<div><Tile /><InjectionPoint name="a.b.c" /></div>\n`
    )
    const result = scanMonolithicRegionsTree(root)
    expect(result.findings).toEqual([])
    expect(result.regions).toBe(2)
    expect(result.routeRegions).toBe(1)
  })

  it('flags an unmarked route file in the tree and exempts a CM-originated one by provenance', () => {
    const root = makeRoot()
    writeFixture(root, TREE_ROUTE, `${SCRIPT}${OK}\n<div>x</div>\n`)
    writeFixture(root, CM_ROUTE, `${SCRIPT}${OK}\n<div>x</div>\n`)
    const result = scanMonolithicRegionsTree(root, [CM_ROUTE])
    expect(result.exempted).toBe(1)
    expect(result.findings.map((finding) => finding.file)).toEqual([TREE_ROUTE])
  })
})
