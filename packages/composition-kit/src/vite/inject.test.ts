import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, createServer, type Plugin } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodegenInjection } from '../inject-codegen.js'
import { invalidateVirtualModules, type DevServerLike } from './index.js'
import { BEHAVIOR_ID, POINT_PREFIX, pvInject } from './inject.js'

// Story 68.4 AC-3: the kit's `pvInject` plugin. Real Vite builds and a real dev server run over an
// in-memory project (a fixtures plugin serves the files; nothing but the lock touches the disk).

const DEV_ENTRY = '/proj/dev-entry.js'
const POINT = 'project.detail.after'
const ROUTE = '/(app)/projects/[projectId]'

function injection(over: Partial<CodegenInjection> = {}): CodegenInjection {
  return {
    point: POINT,
    component: 'src/lib/_cm/Tile.js',
    order: 10,
    load: 'src/lib/server/_cm/tile.server.js',
    actions: 'src/lib/server/_cm/tile.actions.js',
    routeId: ROUTE,
    scope: 'page',
    ...over,
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The files of the composed app, served from memory under `/proj/`; `$lib` maps to `/proj/src/lib`. */
const FILES = new Map<string, string>([
  ['/proj/src/lib/_cm/Tile.js', "export default 'tile-component'\n"],
  ['/proj/src/lib/_cm/Late.js', "export default 'late-component'\n"],
  ['/proj/src/lib/server/_cm/tile.server.js', "export const load = () => 'tile-load'\n"],
  [
    '/proj/src/lib/server/_cm/tile.actions.js',
    "export const actions = { share: () => 'shared' }\n",
  ],
])
const fixtures: Plugin = {
  name: 'kit-test-fixtures',
  enforce: 'pre',
  resolveId(id) {
    const mapped = id.startsWith('$lib/') ? `/proj/src/lib/${id.slice('$lib/'.length)}` : id
    return FILES.has(mapped) ? mapped : null
  },
  load(id) {
    return FILES.get(id) ?? null
  },
}

function lockFile(injections: readonly CodegenInjection[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-inject-'))
  roots.push(dir)
  const path = join(dir, 'composition.lock.json')
  writeFileSync(path, JSON.stringify({ injections }))
  return path
}

describe('pvInject hooks', () => {
  it('runs pre-enforced and resolves exactly its two id families, with a NUL prefix', () => {
    const plugin = pvInject({ injections: [] })
    const resolveId = plugin.resolveId as (id: string) => unknown
    expect(plugin.enforce).toBe('pre')
    expect(resolveId.call({}, `${POINT_PREFIX}a.b.c`)).toBe(`\0${POINT_PREFIX}a.b.c`)
    expect(resolveId.call({}, BEHAVIOR_ID)).toBe(`\0${BEHAVIOR_ID}`)
    expect(resolveId.call({}, './other.js')).toBeNull()
    expect(resolveId.call({}, 'virtual:pv-inject-other')).toBeNull()
  })

  it('serves an empty list for a point nobody contributes to, and ignores foreign ids', () => {
    const plugin = pvInject({ injections: [injection()] })
    const load = plugin.load as (id: string) => unknown
    expect(load.call({}, `\0${POINT_PREFIX}nothing.here.x`)).toBe('export default []\n')
    expect(load.call({}, '/some/file.ts')).toBeNull()
    expect(load.call({}, `\0virtual:other`)).toBeNull()
    expect(load.call({}, `\0${POINT_PREFIX}${POINT}`)).toContain(
      'import c0 from "$lib/_cm/Tile.js"'
    )
    expect(load.call({}, `\0${BEHAVIOR_ID}`)).toContain(`${ROUTE}#page`)
  })

  it('reads the lock on every load, treats a missing lock as no contributions, and a lock without the section too', () => {
    const missing = pvInject({ lockPath: join(tmpdir(), 'kit-inject-does-not-exist.json') })
    const load = missing.load as (id: string) => unknown
    expect(load.call({}, `\0${POINT_PREFIX}${POINT}`)).toBe('export default []\n')
    const older = lockFile([])
    writeFileSync(older, JSON.stringify({ lockfileVersion: 1 }))
    expect(
      (pvInject({ lockPath: older }).load as (id: string) => unknown).call({}, `\0${BEHAVIOR_ID}`)
    ).toContain('export const loads')
  })

  it('registers its prefixes so a manifest change invalidates them in both module graphs', () => {
    pvInject({ injections: [] })
    const invalidated: string[] = []
    const graph = (ids: string[]) => ({
      idToModuleMap: new Map(ids.map((id) => [id, { id }])),
      invalidateModule: (module: { id: string }) => invalidated.push(module.id),
    })
    const server = {
      environments: {
        client: { moduleGraph: graph([`\0${POINT_PREFIX}a.b.c`, '/src/other.ts']) },
        ssr: { moduleGraph: graph([`\0${BEHAVIOR_ID}`]) },
      },
    } as unknown as DevServerLike
    invalidateVirtualModules(server)
    expect(invalidated.sort()).toEqual([`\0${BEHAVIOR_ID}`, `\0${POINT_PREFIX}a.b.c`].sort())
  })
})

async function bundleEntry(
  entry: string,
  injections: readonly CodegenInjection[]
): Promise<string> {
  FILES.set('/proj/entry.js', entry)
  const result = await build({
    root: '/proj',
    configFile: false,
    logLevel: 'silent',
    plugins: [fixtures, pvInject({ injections })],
    build: { ssr: true, write: false, rollupOptions: { input: '/proj/entry.js' } },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (entry2) => (entry2 as { output: { type: string; code?: string }[] }).output
  )
  return outputs.find((output) => output.type === 'chunk')?.code ?? ''
}

async function runBundle(code: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>
}

describe('pvInject in a real build', () => {
  it('statically bundles each point in order and the behavior tables, server side', async () => {
    const code = await bundleEntry(
      [
        `import entries from '${POINT_PREFIX}${POINT}'`,
        `import * as behavior from '${BEHAVIOR_ID}'`,
        'export const ids = entries.map((entry) => entry.id + ":" + entry.component)',
        'export const keys = Object.keys(behavior.loads).concat(Object.keys(behavior.actions))',
        'export const ran = behavior.loads["/(app)/projects/[projectId]#page"][0].contributions[0].load()',
      ].join('\n'),
      [
        injection({ component: 'src/lib/_cm/Late.js', order: 20, load: null, actions: null }),
        injection(),
      ]
    )
    expect(code).not.toContain('import(')
    const loaded = await runBundle(code)
    expect(loaded.ids).toEqual([`${POINT}#0:tile-component`, `${POINT}#1:late-component`])
    expect(loaded.keys).toEqual([`${ROUTE}#page`, `${ROUTE}#page`])
    expect(loaded.ran).toBe('tile-load')
  })

  it('an unlisted point resolves to an empty list in the same build', async () => {
    const code = await bundleEntry(
      `import entries from '${POINT_PREFIX}some.other.point'\nexport const size = entries.length`,
      [injection()]
    )
    expect((await runBundle(code)).size).toBe(0)
  })
})

describe('pvInject in a dev server', () => {
  it('picks up a changed lock after the virtual modules are invalidated, no restart', async () => {
    const lockPath = lockFile([injection()])
    FILES.set(DEV_ENTRY, `export { default } from '${POINT_PREFIX}${POINT}'\n`)
    const server = await createServer({
      root: '/proj',
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, ws: false, watch: null },
      plugins: [fixtures, pvInject({ lockPath })],
    })
    try {
      const first = (await server.ssrLoadModule(DEV_ENTRY)) as {
        default: { order: number }[]
      }
      expect(first.default.map((entry) => entry.order)).toEqual([10])
      writeFileSync(
        lockPath,
        JSON.stringify({
          injections: [injection({ order: 5, component: 'src/lib/_cm/Late.js' }), injection()],
        })
      )
      invalidateVirtualModules(server as unknown as DevServerLike)
      const second = (await server.ssrLoadModule(DEV_ENTRY)) as {
        default: { order: number }[]
      }
      expect(second.default.map((entry) => entry.order)).toEqual([5, 10])
      writeFileSync(lockPath, JSON.stringify({ injections: [] }))
      invalidateVirtualModules(server as unknown as DevServerLike)
      const third = (await server.ssrLoadModule(DEV_ENTRY)) as { default: unknown[] }
      expect(third.default).toEqual([])
    } finally {
      await server.close()
    }
  })
})
