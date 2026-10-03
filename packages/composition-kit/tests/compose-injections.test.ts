import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose, type ComposeResult } from '../src/compose.js'
import { makeWorld, manifest, sha, useWorlds, type World } from './compose-test-helpers.js'

// Story 68.4 AC-2/AC-4/AC-6/AC-15/AC-17: contributions are checked for integrity only, and the lock
// records them. Nothing here limits what a component, load or action may import, render or do.

useWorlds()

const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'
const DASHBOARD_SERVER = 'src/routes/(app)/dashboard/+page.server.ts'
const DASHBOARD_ROUTE = '/(app)/dashboard'
const LOCK = 'composition.lock.json'
const POINT = 'dashboard.home.after'
const TILE = 'injections/Tile.svelte'
const LOAD = 'injections/tile.server.ts'
const ACTIONS = 'injections/tile.actions.ts'
const LOAD_OK = 'export const load = async () => ({ n: 1 })\n'
const ACTIONS_OK = 'export const actions = { share: async () => ({ ok: true }) }\n'

function registry(extra: Record<string, unknown> = {}): Record<string, string> {
  return {
    'manifests/injection-points.json': JSON.stringify({
      schemaVersion: 1,
      points: [
        { name: POINT, file: DASHBOARD, routeId: DASHBOARD_ROUTE, scope: 'page', ...extra },
        { name: 'shell.head', file: 'src/routes/+layout.svelte', routeId: '/', scope: 'layout' },
        { name: 'region.thing.tiles', file: 'src/lib/components/x.svelte', scope: 'component' },
      ],
    }),
  }
}

function run(world: World, pack: unknown): Promise<ComposeResult> {
  return compose({ appRoot: world.app, packRoot: world.pack, hostDir: world.host, manifest: pack })
}

function lockOf(world: World): Record<string, unknown> {
  return JSON.parse(readFileSync(join(world.app, LOCK), 'utf8')) as Record<string, unknown>
}

const files = (extra: Record<string, string> = {}): Record<string, string> => ({
  [TILE]: '<p>tile</p>\n',
  [LOAD]: LOAD_OK,
  [ACTIONS]: ACTIONS_OK,
  ...extra,
})

const contribution = (extra: object = {}) => ({
  injections: {
    [POINT]: [
      { component: `./${TILE}`, order: 10, load: `./${LOAD}`, actions: `./${ACTIONS}`, ...extra },
    ],
  },
})

describe('integrity checks of a contribution (AC-4)', () => {
  it('composes a contribution with a load and actions, relocating them server-side', async () => {
    const world = makeWorld({ hostFiles: registry(), packFiles: files() })
    const result = await run(world, manifest(contribution()))
    expect(result.messages).toEqual([])
    expect(readFileSync(join(world.app, `src/lib/_cm/${TILE}`), 'utf8')).toContain('tile')
    expect(readFileSync(join(world.app, `src/lib/server/_cm/${LOAD}`), 'utf8')).toContain('load')
  })

  it('names a load file that has no named export "load"', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({ [LOAD]: 'export const other = 1\n' }),
    })
    const result = await run(world, manifest(contribution()))
    expect(result.messages).toContain(
      `injections.${POINT}.load: ${LOAD} has no named export "load"`
    )
    expect(result.ok).toBe(false)
  })

  it('says a default export alone is not accepted', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({ [LOAD]: 'export default async () => ({})\n' }),
    })
    const result = await run(world, manifest(contribution()))
    expect(result.messages.join('\n')).toContain(
      'has no named export "load" (a default export is not accepted'
    )
  })

  it('accepts every spelling of a named export, and one level of re-export', async () => {
    const spellings = [
      'export function load() { return {} }\n',
      'export async function load() { return {} }\n',
      'const load = () => ({})\nexport { load }\n',
      'const impl = () => ({})\nexport { impl as load }\n',
      "export { load } from './other'\n",
      "export * from './other'\n",
    ]
    for (const source of spellings) {
      const world = makeWorld({
        hostFiles: registry(),
        packFiles: files({ [LOAD]: source, 'injections/other.ts': LOAD_OK }),
      })
      const result = await run(world, manifest(contribution({ actions: undefined })))
      expect(result.messages, source).toEqual([])
    }
  })

  it('notes a re-export chain deeper than one level as not verified', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({
        [LOAD]: "export * from './one'\n",
        'injections/one.ts': "export * from './two'\n",
        'injections/two.ts': LOAD_OK,
      }),
    })
    const result = await run(world, manifest(contribution({ actions: undefined })))
    expect(result.plan.notes.join('\n')).toContain('not verified')
    expect(result.ok).toBe(true)
  })

  it('names an actions file with no named export "actions"', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({ [ACTIONS]: 'export const other = {}\n' }),
    })
    const result = await run(world, manifest(contribution()))
    expect(result.messages).toContain(
      `injections.${POINT}.actions: ${ACTIONS} has no named export "actions"`
    )
  })

  it('fails two contributions at one point exporting the same action name', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({
        'injections/Other.svelte': '<p>o</p>\n',
        'injections/other.actions.ts': ACTIONS_OK,
      }),
    })
    const pack = manifest({
      injections: {
        [POINT]: [
          { component: `./${TILE}`, actions: `./${ACTIONS}` },
          { component: './injections/Other.svelte', actions: './injections/other.actions.ts' },
        ],
      },
    })
    const result = await run(world, pack)
    expect(result.messages).toContain(
      `action "${POINT}.share" is exported by both ${ACTIONS} and injections/other.actions.ts`
    )
  })

  it('lets a contribution import any lib module and a node builtin (nothing is allowlisted)', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({
        [LOAD]:
          "import { readFileSync } from 'node:fs'\nimport { requireUser } from '$lib/server/auth'\nexport const load = () => ({ readFileSync, requireUser })\n",
      }),
    })
    expect((await run(world, manifest(contribution({ actions: undefined })))).messages).toEqual([])
  })
})

describe('behavior injection needs the registry route and scope (AC-17)', () => {
  it('fails only a pack that declares load or actions against a registry without routeId/scope', async () => {
    const hostFiles = {
      'manifests/injection-points.json': JSON.stringify({
        schemaVersion: 1,
        points: [{ name: POINT, file: DASHBOARD }],
      }),
    }
    const behavior = makeWorld({ hostFiles, packFiles: files() })
    const failed = await run(behavior, manifest(contribution()))
    expect(failed.messages.join('\n')).toContain(
      `injections.${POINT}: behavior injection (load/actions) needs a newer web-host`
    )
    expect(failed.messages.join('\n')).toContain('components-only injection still works')
    const componentsOnly = makeWorld({ hostFiles, packFiles: files() })
    const ok = await run(
      componentsOnly,
      manifest(contribution({ load: undefined, actions: undefined }))
    )
    expect(ok.messages).toEqual([])
  })

  it('records load and actions of a component-scoped point as inert, never refusing them', async () => {
    const world = makeWorld({ hostFiles: registry(), packFiles: files() })
    const pack = manifest({
      injections: {
        'region.thing.tiles': [
          { component: `./${TILE}`, load: `./${LOAD}`, actions: `./${ACTIONS}` },
        ],
      },
    })
    const result = await run(world, pack)
    expect(result.plan.notes.join('\n')).toContain(
      'component-scoped point "region.thing.tiles": behavior injection arrives with Epic 69'
    )
    expect(result.ok).toBe(true)
  })

  it('fails composition when the page server file exports a default action (Kit forbids mixing)', async () => {
    const world = makeWorld({
      hostFiles: {
        ...registry(),
        [DASHBOARD_SERVER]: 'export const actions = { default: async () => ({}) }\n',
      },
      packFiles: files(),
    })
    const result = await run(world, manifest(contribution({ load: undefined })))
    const text = result.messages.join('\n')
    expect(text).toContain(`${DASHBOARD_SERVER} exports a default action`)
    expect(text).toContain('PV story needed: convert the default action to a named one')
    expect(text).toContain('or override the page (M1)')
  })

  it('does not mind a default action when only components and loads are contributed', async () => {
    const world = makeWorld({
      hostFiles: {
        ...registry(),
        [DASHBOARD_SERVER]: 'export const actions = { default: async () => ({}) }\n',
      },
      packFiles: files(),
    })
    const result = await run(world, manifest(contribution({ actions: undefined })))
    expect(result.messages).toEqual([])
  })
})

describe('the lock records injections (AC-15)', () => {
  it('writes sorted composed paths with order filled in, route and scope, and a byte-identical lock', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({ 'injections/Late.svelte': '<p>l</p>\n' }),
    })
    const pack = manifest({
      injections: {
        [POINT]: [
          { component: './injections/Late.svelte', order: 20 },
          { component: `./${TILE}`, load: `./${LOAD}` },
        ],
      },
    })
    expect((await run(world, pack)).messages).toEqual([])
    const first = readFileSync(join(world.app, LOCK), 'utf8')
    expect(lockOf(world).injections).toEqual([
      {
        point: POINT,
        component: 'src/lib/_cm/injections/Tile.svelte',
        order: 0,
        load: 'src/lib/server/_cm/injections/tile.server.ts',
        actions: null,
        routeId: DASHBOARD_ROUTE,
        scope: 'page',
      },
      {
        point: POINT,
        component: 'src/lib/_cm/injections/Late.svelte',
        order: 20,
        load: null,
        actions: null,
        routeId: DASHBOARD_ROUTE,
        scope: 'page',
      },
    ])
    expect((await run(world, pack)).messages).toEqual([])
    expect(readFileSync(join(world.app, LOCK), 'utf8')).toBe(first)
  })

  it('--check fails when a contribution order changes, and treats an older lock as "no injections"', async () => {
    const world = makeWorld({ hostFiles: registry(), packFiles: files() })
    expect((await run(world, manifest(contribution()))).messages).toEqual([])
    const changed = await compose({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: manifest(contribution({ order: 99 })),
      check: true,
    })
    expect(changed.ok).toBe(false)
    expect(changed.messages.join('\n')).toContain('injections')
  })

  it('keeps working against a host that renamed nothing: a point that vanished while the page is overridden is a note', async () => {
    const world = makeWorld({
      hostFiles: registry(),
      packFiles: files({ [DASHBOARD]: 'cm page\n' }),
    })
    const first = await run(
      world,
      manifest({
        routes: { overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD) }] },
        injections: { [POINT]: [{ component: `./${TILE}` }] },
      })
    )
    expect(first.messages).toEqual([])
  })
})
