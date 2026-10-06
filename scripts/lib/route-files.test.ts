import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './fixture-test-helpers.js'
import { listRouteFiles, parseMarkup, parseServerFile, routeIdOfDir } from './route-files.js'

const makeRoot = useFixtureRoots('route-files-', ['src/routes'])
const PAGE_SERVER = '+page.server.ts'
const POINT = '<InjectionPoint name="a.b.before" props={{}} />'

describe('routeIdOfDir', () => {
  it.each([
    ['', '/'],
    ['.', '/'],
    ['(app)/dashboard', '/(app)/dashboard'],
    ['(app)/projects/[projectId]', '/(app)/projects/[projectId]'],
    ['(app)/extensions/panels/[slot]/[...subpath]', '/(app)/extensions/panels/[slot]/[...subpath]'],
    ['a/[[optional]]', '/a/[[optional]]'],
  ])('%s -> %s', (dir, id) => {
    expect(routeIdOfDir(dir)).toBe(id)
  })
})

describe('listRouteFiles', () => {
  it('finds route components and load files, skipping tests and +server.ts, sorted', () => {
    const root = makeRoot()
    for (const file of [
      '+layout.svelte',
      '+error.svelte',
      '+page.svelte',
      PAGE_SERVER,
      '(app)/+layout.svelte',
      '(app)/+layout.server.ts',
      '(app)/p/[id]/+page.svelte',
      '(app)/p/[id]/+page.ts',
      '(app)/p/[id]/+server.ts',
      '(app)/p/[id]/page.test.ts',
      '(app)/p/__tests__/+page.svelte',
      '(app)/p/+page.server.test.ts',
    ]) {
      writeFixture(root, `src/routes/${file}`, '')
    }
    const { routes, servers } = listRouteFiles(root)
    expect(routes.map((r) => `${r.kind} ${r.routeId}`)).toEqual([
      'layout /(app)',
      'page /(app)/p/[id]',
      'error /',
      'layout /',
      'page /',
    ])
    expect(
      servers.map((s) => `${s.kind} ${s.universal ? 'universal' : 'server'} ${s.routeId}`)
    ).toEqual(['layout server /(app)', 'page universal /(app)/p/[id]', 'page server /'])
  })

  it('returns nothing for a tree with no routes (callers must fail closed on that)', () => {
    expect(listRouteFiles(makeRoot())).toEqual({ routes: [], servers: [] })
  })
})

describe('parseMarkup: points', () => {
  it('reads literal names with their lines, in every markup context', () => {
    const { points } = parseMarkup(
      [
        '<svelte:head><InjectionPoint name="shell.head" /></svelte:head>',
        '{#if x}',
        '  <InjectionPoint name={"a.b.if"} />',
        '{/if}',
        '{#snippet s()}<InjectionPoint name="a.b.snip" />{/snippet}',
        '{@render s()}',
      ].join('\n'),
      'x.svelte'
    )
    expect(points).toEqual([
      { name: 'shell.head', line: 1 },
      { name: 'a.b.if', line: 3 },
      { name: 'a.b.snip', line: 5 },
    ])
  })

  it('moves a point out of `points` when its snippet is never rendered or its branch never runs (69.6)', () => {
    const parsed = parseMarkup(
      [
        '{#snippet s()}<InjectionPoint name="a.b.snip" />{/snippet}',
        '{#if false}<InjectionPoint name="a.b.dead" />{/if}',
        '<Panel>{#snippet row()}<InjectionPoint name="a.b.prop" />{/snippet}</Panel>',
        '{#snippet outer()}<Panel><InjectionPoint name="a.b.nested" /></Panel>{/snippet}',
      ].join('\n'),
      'x.svelte'
    )
    expect(parsed.points.map((p) => p.name)).toEqual(['a.b.prop'])
    expect(parsed.deadPoints.map((p) => [p.name, p.reason])).toEqual([
      ['a.b.dead', 'inside markup behind a literal {#if} that never renders it'],
      ['a.b.snip', 'inside {#snippet s}, which is never rendered'],
      ['a.b.nested', 'inside {#snippet outer}, which is never rendered'],
    ])
  })

  it('reports a dynamic or interpolated name as null', () => {
    const { points } = parseMarkup(
      '<InjectionPoint name={x} />\n<InjectionPoint name="a{b}" />\n<InjectionPoint />',
      'x.svelte'
    )
    expect(points.map((p) => p.name)).toEqual([null, null, null])
  })
})

describe('parseMarkup: @region blocks', () => {
  const problems = (markup: string) => parseMarkup(markup, 'x.svelte').regionProblems

  it('accepts an element, an if block and an each block containing a point', () => {
    expect(problems(`<!-- @region tiles -->\n<div>${POINT}</div>`)).toEqual([])
    expect(problems(`<!-- @region r -->\n{#if x}<p>${POINT}</p>{/if}`)).toEqual([])
    expect(problems(`<!-- @region r -->\n{#each xs as x}${POINT}{/each}`)).toEqual([])
  })

  it('flags a region without a point, at the end of a file, and with a malformed comment', () => {
    expect(problems('<!-- @region tiles -->\n<div>none</div>')).toEqual([
      { line: 1, message: '@region block contains no <InjectionPoint>' },
    ])
    expect(problems('<p>x</p>\n<!-- @region tiles -->')).toEqual([
      { line: 2, message: '@region comment is not followed by an element or block' },
    ])
    expect(problems(`<!-- @region -->\n<div>${POINT}</div>`)).toEqual([
      { line: 1, message: '@region comment must be written `<!-- @region <name> -->`' },
    ])
  })

  it('ignores ordinary comments and treats only the next sibling as the annotated node', () => {
    expect(problems('<!-- note -->\n<div></div>')).toEqual([])
    expect(problems(`<!-- @region r -->\n<div></div>\n<div>${POINT}</div>`)).toHaveLength(1)
  })
})

describe('parseServerFile', () => {
  it('reads injectLoad route id and scope, injectActions route id, and own action keys', () => {
    const calls = parseServerFile(
      [
        "import { injectActions, injectLoad } from '$lib/server/composition/inject-behavior.js'",
        "export const load = async (event) => ({ ...(await injectLoad(event, '/(app)/x', 'page')) })",
        "export const actions = { ...own, ...injectActions('/(app)/x'), save: async () => ({}), 'a.b': () => 1 }",
      ].join('\n'),
      PAGE_SERVER
    )
    expect(calls.loadCalls).toEqual([{ routeId: '/(app)/x', scope: 'page' }])
    expect(calls.actionCalls).toEqual(['/(app)/x'])
    expect(calls.actionKeys).toEqual(['save', 'a.b'])
    expect(calls.hasDefaultAction).toBe(false)
  })

  it('reads withInjectedLoad(own, route, scope) like injectLoad', () => {
    const calls = parseServerFile(
      "export const load = withInjectedLoad(ownLoad, '/(app)/x', 'layout')",
      '+layout.server.ts'
    )
    expect(calls.loadCalls).toEqual([{ routeId: '/(app)/x', scope: 'layout' }])
  })

  it('flags a default action, a satisfies/as wrapper and non-literal arguments', () => {
    const calls = parseServerFile(
      'export const actions = { default: async () => ({}) } satisfies Actions\nawait injectLoad(event, id, scope)\ninjectActions(id)',
      PAGE_SERVER
    )
    expect(calls.hasDefaultAction).toBe(true)
    expect(calls.loadCalls).toEqual([{ routeId: null, scope: null }])
    expect(calls.actionCalls).toEqual([null])
  })

  it('reports nothing for a file with no calls and no actions', () => {
    expect(parseServerFile('export const load = () => ({})', 'a.ts')).toEqual({
      loadCalls: [],
      actionCalls: [],
      actionKeys: [],
      hasDefaultAction: false,
    })
  })
})
