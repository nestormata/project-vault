import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  behaviorKey,
  composedSpecifier,
  generateBehaviorModule,
  generatePointModule,
  type CodegenInjection,
} from './inject-codegen.js'

// Story 68.4 AC-3 / AC-5 / AC-6 / AC-14 / AC-17: the kit's generated virtual modules. Built with
// JSON.stringify only, null-prototype frozen tables, no module-level mutable state.

const requireTs = createRequire(import.meta.url)
const ts = requireTs('typescript') as typeof import('typescript')

const POINT_NAME = 'project.detail.after'
const B_SVELTE = 'src/lib/_cm/B.svelte'
const COMPONENT = 'src/lib/_cm/injections/Tile.svelte'
const LOAD = 'src/lib/server/_cm/injections/tile.server.ts'
const ACTIONS = 'src/lib/server/_cm/injections/tile.actions.ts'
const PAGE_ROUTE = '/(app)/projects/[projectId]'

function entry(over: Partial<CodegenInjection> = {}): CodegenInjection {
  return {
    point: POINT_NAME,
    component: COMPONENT,
    order: 10,
    load: LOAD,
    actions: ACTIONS,
    routeId: PAGE_ROUTE,
    scope: 'page',
    ...over,
  }
}

function syntaxErrors(source: string): readonly unknown[] {
  return (
    ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).diagnostics ?? []
  )
}

/** Runs a generated module with its imports replaced by stubs; returns its exports. */
async function evaluate(
  source: string,
  stubs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const body = source
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
  const prelude = Object.keys(stubs)
    .map((name) => `const ${name} = globalThis.__stubs.${name}`)
    .join('\n')
  ;(globalThis as { __stubs?: unknown }).__stubs = stubs
  const url = `data:text/javascript;base64,${Buffer.from(`${prelude}\n${body}`).toString('base64')}`
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>
}

describe('composedSpecifier', () => {
  it('maps composed paths under src/lib to $lib and everything else to a root-relative path', () => {
    expect(composedSpecifier(COMPONENT)).toBe('$lib/_cm/injections/Tile.svelte')
    expect(composedSpecifier(LOAD)).toBe('$lib/server/_cm/injections/tile.server.ts')
    expect(composedSpecifier('src/other/x.ts')).toBe('/src/other/x.ts')
  })
})

describe('behaviorKey', () => {
  it('keys by route id and scope, mapping shell to layout, and never for component scope', () => {
    expect(behaviorKey({ routeId: PAGE_ROUTE, scope: 'page' })).toBe(`${PAGE_ROUTE}#page`)
    expect(behaviorKey({ routeId: '/(app)', scope: 'shell' })).toBe('/(app)#layout')
    expect(behaviorKey({ routeId: '/', scope: 'layout' })).toBe('/#layout')
    expect(behaviorKey({ routeId: null, scope: 'component' })).toBeNull()
    expect(behaviorKey({ routeId: null, scope: null })).toBeNull()
    expect(behaviorKey({ routeId: '/x', scope: 'error' })).toBeNull()
  })
})

describe('generatePointModule', () => {
  it('exports an empty list for a point nobody contributes to', () => {
    expect(generatePointModule('a.b.c', [])).toBe('export default []\n')
  })

  it('statically imports each component and lists them in the order given', async () => {
    const source = generatePointModule(POINT_NAME, [
      entry({ component: 'src/lib/_cm/A.svelte', order: 10 }),
      entry({ component: B_SVELTE, order: 20 }),
    ])
    expect(source).toContain('import c0 from "$lib/_cm/A.svelte"')
    expect(source).toContain('import c1 from "$lib/_cm/B.svelte"')
    expect(source).not.toContain('import(')
    expect(syntaxErrors(source)).toEqual([])
    const exports = await evaluate(source, { c0: 'A', c1: 'B' })
    expect(exports.default).toEqual([
      { id: 'project.detail.after#0', order: 10, component: 'A' },
      { id: 'project.detail.after#1', order: 20, component: 'B' },
    ])
  })

  it('escapes a point name and a path with quotes, backticks, ${, backslashes and newlines', () => {
    const nasty = 'a"b\'c`d${e}\\f\ng</script>'
    const source = generatePointModule(nasty, [
      entry({ point: nasty, component: `src/lib/_cm/${nasty}.svelte` }),
    ])
    expect(syntaxErrors(source)).toEqual([])
    const parsed = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true)
    const specifiers = parsed.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : []
    )
    expect(specifiers).toEqual([`$lib/_cm/${nasty}.svelte`])
  })
})

describe('generateBehaviorModule', () => {
  const TWO = [
    entry({ order: 20, component: B_SVELTE, load: null, actions: null }),
    entry({ order: 10 }),
  ]

  it('groups by route id and scope, aligned to the contributions, and imports each file once', async () => {
    const source = generateBehaviorModule([TWO[1] as CodegenInjection, TWO[0] as CodegenInjection])
    expect(syntaxErrors(source)).toEqual([])
    expect(source.match(/^import /gm)).toHaveLength(2)
    const load = () => 'loaded'
    const run = () => 'ran'
    const exports = await evaluate(source, { m0: { load }, m1: { actions: { share: run } } })
    const loads = exports.loads as Record<string, unknown>
    expect(Object.getPrototypeOf(loads)).toBeNull()
    expect(Object.isFrozen(loads)).toBe(true)
    expect(loads[`${PAGE_ROUTE}#page`]).toEqual([
      {
        point: POINT_NAME,
        contributions: [
          { order: 10, load },
          { order: 20, load: null },
        ],
      },
    ])
    const actions = exports.actions as Record<string, Record<string, unknown>>
    expect(Object.getPrototypeOf(actions)).toBeNull()
    expect(actions[`${PAGE_ROUTE}#page`]).toEqual({
      'project.detail.after.share': { point: POINT_NAME, name: 'share', run },
    })
  })

  it('a point whose contributions have no load is left out of the loads table', async () => {
    const source = generateBehaviorModule([entry({ load: null, actions: null })])
    const exports = await evaluate(source, {})
    expect(exports.loads).toEqual({})
    expect(exports.actions).toEqual({})
  })

  it('treats layout and shell scopes alike, and records component- and error-scoped points as inert', async () => {
    const source = generateBehaviorModule([
      entry({ scope: 'shell', routeId: '/(app)', point: 'shell.header.end', actions: null }),
      entry({ scope: 'component', routeId: null, point: 'region.x.y' }),
      entry({ scope: 'error', routeId: '/', point: 'root.error.before' }),
    ])
    const exports = await evaluate(source, { m0: { load: () => 1 } })
    expect(Object.keys(exports.loads as object)).toEqual(['/(app)#layout'])
    expect(exports.actions).toEqual({})
  })

  it('has prototype-safe tables: a point or route named __proto__ or constructor stays an own key', async () => {
    const source = generateBehaviorModule([
      entry({ point: '__proto__', routeId: 'constructor', actions: null }),
    ])
    const exports = await evaluate(source, { m0: { load: () => 1 } })
    const loads = exports.loads as Record<string, unknown>
    expect(Object.keys(loads)).toEqual(['constructor#page'])
    expect(loads.toString).toBeUndefined()
  })

  it('fails loudly at load time when two contributions export the same action key', async () => {
    const source = generateBehaviorModule([
      entry({ order: 1, load: null }),
      entry({
        order: 2,
        load: null,
        component: B_SVELTE,
        actions: 'src/lib/server/_cm/other.actions.ts',
      }),
    ])
    await expect(
      evaluate(source, { m0: { actions: { share: 1 } }, m1: { actions: { share: 2 } } })
    ).rejects.toThrow('duplicate injected action "project.detail.after.share"')
  })

  it('is pure: no top-level let, var, Map, Set, process or environment access, no eval', () => {
    const source = generateBehaviorModule(TWO)
    for (const token of [
      /^\s*(let|var)\s/m,
      /new (Map|Set|WeakMap)\b/,
      /process\./,
      /\beval\b/,
      /new Function/,
      /Date\.now/,
    ]) {
      expect(source).not.toMatch(token)
    }
  })

  it('escapes odd route ids and point names (JSON.stringify only)', () => {
    const nasty = '/a"b`c${d}\\e'
    const source = generateBehaviorModule([
      entry({ routeId: nasty, point: `p"${nasty}`, actions: null }),
    ])
    expect(syntaxErrors(source)).toEqual([])
    expect(source).toContain(JSON.stringify(`${nasty}#page`))
  })
})
