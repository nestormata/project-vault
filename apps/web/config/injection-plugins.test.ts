// @vitest-environment node
import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { build, type Plugin } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  BEHAVIOR_MODULE_ID,
  EMPTY_BEHAVIOR_MODULE,
  EMPTY_POINT_MODULE,
  emptyInjectionModules,
  injectionEntries,
  rewriteInjectionPoints,
} from './injection-plugins.ts'
import { webHostPlugins } from './vite.config.ts'

// Story 68.4 AC-3: the PV transform, the empty provider, and the Q2 spike kept as a permanent
// assertion (SSR renders the injected markup from a STATIC import; a page without a contribution
// does not pull the point's components).

const WEB_DIR = resolve(import.meta.dirname, '..')
const COMPONENT_SOURCE = import.meta.glob(
  '../src/lib/components/composition/InjectionPoint.svelte',
  { query: '?raw', import: 'default', eager: true }
)
const PREFIX = 'virtual:pv-inject/'
const POINT = '<InjectionPoint name="a.b.c" props={{}} />'
const FILE = '/app/Page.svelte'
const STRING_LITERAL = 'string literal'

describe('rewriteInjectionPoints (Q2 transform)', () => {
  it('returns null when there is nothing to rewrite', () => {
    expect(rewriteInjectionPoints('<p>hi</p>', FILE)).toBeNull()
    expect(rewriteInjectionPoints('<InjectionPoint name="a.b.c" entries={x} />', FILE)).toBeNull()
  })

  it('adds one static import per use and an entries attribute (instance script present)', () => {
    const out = rewriteInjectionPoints(
      `<script lang="ts">\n  let x = 1\n</script>\n<InjectionPoint name="a.b.before" props={{}} />\n<InjectionPoint name="a.b.after" props={{}} />`,
      FILE
    )
    expect(out).toContain(`import __pvInject_0 from "${PREFIX}a.b.before"`)
    expect(out).toContain(`import __pvInject_1 from "${PREFIX}a.b.after"`)
    expect(out).toContain('<InjectionPoint entries={__pvInject_0} name="a.b.before"')
    expect(out).toContain('<InjectionPoint entries={__pvInject_1} name="a.b.after"')
  })

  it('creates an instance script when the file has none, keeping the module script language', () => {
    const none = rewriteInjectionPoints(POINT, FILE)
    expect(none?.startsWith('<script>\nimport __pvInject_0')).toBe(true)
    const moduleOnly = rewriteInjectionPoints(
      `<script module lang="ts">\n  export const x = 1\n</script>\n${POINT}`,
      FILE
    )
    expect(moduleOnly?.startsWith('<script lang="ts">\nimport __pvInject_0')).toBe(true)
  })

  it('reaches points inside snippets, each, if and svelte:head, and accepts a string-literal expression', () => {
    const out = rewriteInjectionPoints(
      [
        '<svelte:head><InjectionPoint name="shell.head" props={{}} /></svelte:head>',
        '{#snippet s()}<InjectionPoint name="a.b.snip" props={{}} />{/snippet}',
        '{#each [1] as i}<InjectionPoint name={"a.b.each"} props={{}} />{/each}',
        '{#if true}<InjectionPoint name="a.b.if" props={{}} />{/if}',
      ].join('\n'),
      FILE
    )
    for (const name of ['shell.head', 'a.b.snip', 'a.b.each', 'a.b.if']) {
      expect(out).toContain(`"${PREFIX}${name}"`)
    }
    expect(out?.match(/entries=\{__pvInject_\d\}/g)).toHaveLength(4)
  })

  it('never collides with a user identifier', () => {
    const out = rewriteInjectionPoints(
      `<script>\n  const __pvInject_0 = 1\n</script>\n${POINT}`,
      FILE
    )
    expect(out).toContain('import __pvInject_1 from')
    expect(out).toContain('entries={__pvInject_1}')
  })

  it('escapes odd names through JSON.stringify (no raw splice)', () => {
    const name = 'a.b.c"d\'e`f${g}'
    const out = rewriteInjectionPoints(`<InjectionPoint name={${JSON.stringify(name)}} />`, FILE)
    expect(out).toContain(JSON.stringify(`${PREFIX}${name}`))
  })

  it('fails the build for a non-literal or missing name, naming file and line', () => {
    expect(() =>
      rewriteInjectionPoints('<p>x</p>\n<InjectionPoint name={someVar} props={{}} />', FILE)
    ).toThrow(
      'InjectionPoint name must be a string literal because its module is imported statically (/app/Page.svelte:2)'
    )
    expect(() => rewriteInjectionPoints('<InjectionPoint props={{}} />', FILE)).toThrow(
      'InjectionPoint needs a "name" attribute (/app/Page.svelte:1)'
    )
    expect(() => rewriteInjectionPoints('<InjectionPoint name />', FILE)).toThrow(STRING_LITERAL)
    expect(() => rewriteInjectionPoints('<InjectionPoint name="a{b}" />', FILE)).toThrow(
      STRING_LITERAL
    )
  })
})

describe('injection plugins: shapes and PV order', () => {
  it('transforms .svelte files only, skips queried ids, and leaves the rest alone', () => {
    const plugin = injectionEntries()
    const transform = plugin.transform as (code: string, id: string) => unknown
    const call = (code: string, id: string) => transform.call({}, code, id)
    expect(call(POINT, '/x/a.ts')).toBeNull()
    expect(call(POINT, '/x/a.svelte?svelte&type=style&lang.css')).toBeNull()
    expect(call(POINT, '/x/a.svelte?raw')).toBeNull()
    expect(call('<p>x</p>', '/x/a.svelte')).toBeNull()
    expect(call(POINT, '/x/a.svelte')).toMatchObject({ code: expect.stringContaining('entries=') })
    expect(plugin.enforce).toBe('pre')
  })

  it('the empty provider answers every injection id with an empty module, post-enforced', () => {
    const plugin = emptyInjectionModules()
    const resolveId = plugin.resolveId as (id: string) => unknown
    const load = plugin.load as (id: string) => unknown
    expect(plugin.enforce).toBe('post')
    expect(resolveId.call({}, `${PREFIX}x.y.z`)).toBe(`\0${PREFIX}x.y.z`)
    expect(resolveId.call({}, BEHAVIOR_MODULE_ID)).toBe(`\0${BEHAVIOR_MODULE_ID}`)
    expect(resolveId.call({}, './other')).toBeNull()
    expect(load.call({}, `\0${PREFIX}x.y.z`)).toBe(EMPTY_POINT_MODULE)
    expect(load.call({}, `\0${BEHAVIOR_MODULE_ID}`)).toBe(EMPTY_BEHAVIOR_MODULE)
    expect(load.call({}, '/other')).toBeNull()
  })

  it('webHostPlugins keeps the order: tailwind, paraglide, injection transform, empty provider, sveltekit', async () => {
    const names = (await Promise.all(webHostPlugins().flat())).flat().map((p) => (p as Plugin).name)
    const entries = names.indexOf('pv-injection-entries')
    const empty = names.indexOf('pv-injection-empty')
    const paraglide = names.findIndex((name) => name.includes('paraglide'))
    const kit = names.findIndex((name) => name.startsWith('vite-plugin-sveltekit'))
    expect(names[0]).toMatch(/tailwind/)
    expect(paraglide).toBeGreaterThan(0)
    expect(entries).toBeGreaterThan(paraglide)
    expect(empty).toBe(entries + 1)
    expect(kit).toBeGreaterThan(empty)
  })
})

/** An in-memory project: every file below is served by a plugin, nothing touches the disk. */
const SPIKE_COMPONENT = '/pv-spike/InjectionPoint.svelte'
const FILES = new Map<string, string>([
  ['$app/state', 'export const page = { route: { id: null }, params: {} }\n'],
  ['/pv-spike/Tile.svelte', '<p id="tile">tile</p>\n'],
  [
    '/pv-spike/Page.svelte',
    `<script lang="ts">\n  import InjectionPoint from '${SPIKE_COMPONENT}'\n</script>\n<InjectionPoint name="a.b.after" props={{}} />\n<InjectionPoint name="a.b.before" props={{}}>\n  {#snippet fallback()}<i id="fallback">fb</i>{/snippet}\n</InjectionPoint>\n`,
  ],
  [
    '/pv-spike/Other.svelte',
    `<script lang="ts">\n  import InjectionPoint from '${SPIKE_COMPONENT}'\n</script>\n<InjectionPoint name="a.b.empty" props={{}} />\n`,
  ],
  [
    '/pv-spike/entry.js',
    `import { render } from 'svelte/server'\nimport Page from '/pv-spike/Page.svelte'\nexport const page = () => render(Page, { props: {} }).body\n`,
  ],
  [
    '/pv-spike/client.js',
    `globalThis.pages = [() => import('/pv-spike/Page.svelte'), () => import('/pv-spike/Other.svelte')]\n`,
  ],
])

const fixtures: Plugin = {
  name: 'spike-fixtures',
  enforce: 'pre',
  resolveId(id) {
    return id === SPIKE_COMPONENT || FILES.has(id) ? id : null
  },
  load(id) {
    if (id === SPIKE_COMPONENT) return Object.values(COMPONENT_SOURCE)[0] as string
    return FILES.get(id) ?? null
  },
}

/** A stand-in for the kit's `pvInject`: contributes one component to `a.b.after` only. */
const fakeKit: Plugin = {
  name: 'fake-kit',
  enforce: 'pre',
  resolveId(id) {
    return id === `${PREFIX}a.b.after` ? `\0${id}` : null
  },
  load(id) {
    return id === `\0${PREFIX}a.b.after`
      ? `import C from '/pv-spike/Tile.svelte'\nexport default [{ id: 'a.b.after', order: 1, component: C }]\n`
      : null
  },
}

type Output = { fileName: string; type: string; code?: string }

async function bundle(input: string, withKit: boolean, ssr: boolean): Promise<Output[]> {
  const result = await build({
    root: WEB_DIR,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      fixtures,
      injectionEntries(),
      ...(withKit ? [fakeKit] : []),
      emptyInjectionModules(),
      ...(svelte() as Plugin[]),
    ],
    ...(ssr ? { ssr: { noExternal: true } } : {}),
    build: { ssr, write: false, rollupOptions: { input } },
  })
  const builds = Array.isArray(result) ? result : [result]
  return builds.flatMap((entry) => (entry as { output: Output[] }).output)
}

async function renderPage(withKit: boolean): Promise<string> {
  const outputs = await bundle('/pv-spike/entry.js', withKit, true)
  const code = outputs.find((entry) => entry.type === 'chunk')?.code ?? ''
  const loaded = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )) as { page: () => string }
  return loaded.page()
}

describe('Q2 spike, kept: static import renders on the server and stays per page', () => {
  it('SSR output contains the injected markup from the static import, and PV alone renders fallbacks', async () => {
    const composed = await renderPage(true)
    expect(composed).toContain('id="tile"')
    expect(composed).toContain('id="fallback"')
    const pv = await renderPage(false)
    expect(pv).not.toContain('id="tile"')
    expect(pv).toContain('id="fallback"')
  })

  it('a client build keeps a point nobody uses out of a page that does not render it', async () => {
    const chunks = (await bundle('/pv-spike/client.js', true, false)).filter(
      (entry) => entry.type === 'chunk'
    )
    const withTile = chunks.filter((chunk) => chunk.code?.includes('tile') === true)
    const other = chunks.find((chunk) => chunk.fileName.includes('Other'))
    expect(withTile.length).toBeGreaterThan(0)
    expect(other).toBeDefined()
    expect(other?.code).not.toContain('tile')
  })
})
