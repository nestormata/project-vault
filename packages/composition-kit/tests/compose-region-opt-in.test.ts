import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose, type ComposeResult } from '../src/compose.js'
import { readLock } from '../src/lock.js'
import { makeWorld, manifest, sha, useWorlds, type World } from './compose-test-helpers.js'

// Story 69.1 AC-4 (Q12 option B): a contribution at a COMPONENT-scoped region point may opt in to
// behavior injection with `hostRoutes: ['<routeId>#<scope>']`. The names are checked for integrity
// only (they must be routes that render the point); a pack that does not opt in still gets its
// component, and a load declared without the opt-in is recorded as a note, never refused.

useWorlds()

const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'
const DASHBOARD_SERVER = 'src/routes/(app)/dashboard/+page.server.ts'
const DASHBOARD_ROUTE = '/(app)/dashboard'
const DASHBOARD_PAGE_HOST = `${DASHBOARD_ROUTE}#page`
const PROJECT_ROUTE = '/(app)/projects/[projectId]'
const PROJECT_PAGE_HOST = `${PROJECT_ROUTE}#page`
const PROJECT_LAYOUT_HOST = `${PROJECT_ROUTE}#layout`
const LOCK = 'composition.lock.json'
const REGION = 'dashboard.home.activity'
const LAYOUT_REGION = 'project.layout.nav'
const TILE = 'injections/Tile.svelte'
const LOAD = 'injections/tile.server.ts'
const ACTIONS = 'injections/tile.actions.ts'
const LOAD_OK = 'export const load = async () => ({ n: 1 })\n'
const ACTIONS_OK = 'export const actions = { share: async () => ({ ok: true }) }\n'

/** The host's registry; `null` stands for a web-host that predates `hostRoutes`. */
function hostRegistry(
  hostRoutes: ReadonlyMap<string, string[]> | null = new Map()
): Record<string, string> {
  const withHosts = (name: string, list: string[]) =>
    hostRoutes === null ? {} : { hostRoutes: hostRoutes.get(name) ?? list }
  return {
    'manifests/injection-points.json': JSON.stringify({
      schemaVersion: 1,
      points: [
        {
          name: REGION,
          file: 'src/lib/components/dashboard/RecentActivitySection.svelte',
          scope: 'component',
          kind: 'region',
          ...withHosts(REGION, [DASHBOARD_PAGE_HOST]),
        },
        {
          name: LAYOUT_REGION,
          file: 'src/lib/components/projects/ProjectNavRegion.svelte',
          scope: 'component',
          kind: 'region',
          ...withHosts(LAYOUT_REGION, [PROJECT_LAYOUT_HOST]),
        },
        {
          name: 'dashboard.home.after',
          file: DASHBOARD,
          routeId: DASHBOARD_ROUTE,
          scope: 'page',
          kind: 'standard',
        },
      ],
    }),
  }
}

const files = (extra: Record<string, string> = {}): Record<string, string> => ({
  [TILE]: '<p>tile</p>\n',
  [LOAD]: LOAD_OK,
  [ACTIONS]: ACTIONS_OK,
  ...extra,
})

function run(world: World, pack: unknown): Promise<ComposeResult> {
  return compose({ appRoot: world.app, packRoot: world.pack, hostDir: world.host, manifest: pack })
}

function lockInjections(world: World): Record<string, unknown>[] {
  const read = readLock(join(world.app, LOCK))
  return (read?.lock?.injections ?? []) as unknown as Record<string, unknown>[]
}

const at = (point: string, entry: object) =>
  manifest({ injections: { [point]: [{ component: `./${TILE}`, ...entry }] } })

describe('opting a region point in to behavior (AC-4)', () => {
  it('accepts an opted-in load and records the host routes in the lock', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(
      world,
      at(REGION, { load: `./${LOAD}`, hostRoutes: [DASHBOARD_PAGE_HOST] })
    )
    expect(result.messages).toEqual([])
    expect(lockInjections(world)).toEqual([
      {
        point: REGION,
        component: 'src/lib/_cm/injections/Tile.svelte',
        order: 0,
        load: 'src/lib/server/_cm/injections/tile.server.ts',
        actions: null,
        routeId: null,
        scope: 'component',
        hostRoutes: [DASHBOARD_PAGE_HOST],
      },
    ])
  })

  it('accepts opted-in actions on a page host', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(
      world,
      at(REGION, { actions: `./${ACTIONS}`, hostRoutes: [DASHBOARD_PAGE_HOST] })
    )
    expect(result.messages).toEqual([])
  })

  it('deduplicates repeated host routes silently', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(
      world,
      at(REGION, { load: `./${LOAD}`, hostRoutes: [DASHBOARD_PAGE_HOST, DASHBOARD_PAGE_HOST] })
    )
    expect(result.messages).toEqual([])
    expect(lockInjections(world)[0]?.hostRoutes).toEqual([DASHBOARD_PAGE_HOST])
  })

  it('without the opt-in the load is a note naming hostRoutes and the routes that render the point, never a refusal', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(world, at(REGION, { load: `./${LOAD}` }))
    expect(result.ok).toBe(true)
    const notes = result.plan.notes.join('\n')
    expect(notes).toContain(`component-scoped point "${REGION}"`)
    expect(notes).toContain('hostRoutes')
    expect(notes).toContain(DASHBOARD_PAGE_HOST)
    const entry = lockInjections(world)[0]
    expect(entry).not.toHaveProperty('hostRoutes')
    expect(entry?.load).toBe('src/lib/server/_cm/injections/tile.server.ts')
  })

  it('fails a host route that does not render the point, naming the point, the entry and the valid ones', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(
      world,
      at(REGION, { load: `./${LOAD}`, hostRoutes: [`${DASHBOARD_ROUTE}-typo#page`] })
    )
    expect(result.ok).toBe(false)
    const text = result.messages.join('\n')
    expect(text).toContain(`injections.${REGION}.hostRoutes`)
    expect(text).toContain(`${DASHBOARD_ROUTE}-typo#page`)
    expect(text).toContain(DASHBOARD_PAGE_HOST)
  })

  it.each([`${DASHBOARD_ROUTE}#layout`, DASHBOARD_ROUTE, `${DASHBOARD_ROUTE}#shell`])(
    'fails a layout host for a region only a page renders, and a malformed or unknown-scope key: %s',
    async (bad) => {
      const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
      const result = await run(world, at(REGION, { load: `./${LOAD}`, hostRoutes: [bad] }))
      expect(result.ok).toBe(false)
      expect(result.messages.join('\n')).toContain(bad)
    }
  )

  it('fails an empty hostRoutes list: opted in to nothing is never a silent no-op', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(world, at(REGION, { load: `./${LOAD}`, hostRoutes: [] }))
    expect(result.ok).toBe(false)
    expect(result.messages.join('\n')).toContain('opted in to nothing')
  })

  it('refuses opted-in actions on a layout-hosted region (a layout has no form actions) but lets it carry a load', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const refused = await run(
      world,
      at(LAYOUT_REGION, { actions: `./${ACTIONS}`, hostRoutes: [PROJECT_LAYOUT_HOST] })
    )
    expect(refused.ok).toBe(false)
    expect(refused.messages.join('\n')).toContain('a layout-scoped point has no form actions')
    const loaded = await run(
      world,
      at(LAYOUT_REGION, { load: `./${LOAD}`, hostRoutes: [PROJECT_LAYOUT_HOST] })
    )
    expect(loaded.messages).toEqual([])
  })

  it('opts in on one of two host routes only', async () => {
    const world = makeWorld({
      hostFiles: hostRegistry(new Map([[REGION, [DASHBOARD_PAGE_HOST, PROJECT_PAGE_HOST]]])),
      packFiles: files(),
    })
    const result = await run(
      world,
      at(REGION, { load: `./${LOAD}`, hostRoutes: [PROJECT_PAGE_HOST] })
    )
    expect(result.messages).toEqual([])
    expect(lockInjections(world)[0]?.hostRoutes).toEqual([PROJECT_PAGE_HOST])
  })

  it('fails composition when the host page server file exports a default action and actions are opted in', async () => {
    const world = makeWorld({
      hostFiles: {
        ...hostRegistry(),
        [DASHBOARD_SERVER]: 'export const actions = { default: async () => ({}) }\n',
      },
      packFiles: files(),
    })
    const result = await run(
      world,
      at(REGION, { actions: `./${ACTIONS}`, hostRoutes: [DASHBOARD_PAGE_HOST] })
    )
    expect(result.messages.join('\n')).toContain(`${DASHBOARD_SERVER} exports a default action`)
  })

  it('fails duplicate action names across two contributions opted in at one region point', async () => {
    const world = makeWorld({
      hostFiles: hostRegistry(),
      packFiles: files({
        'injections/Other.svelte': '<p>o</p>\n',
        'injections/other.actions.ts': ACTIONS_OK,
      }),
    })
    const result = await run(
      world,
      manifest({
        injections: {
          [REGION]: [
            { component: `./${TILE}`, actions: `./${ACTIONS}`, hostRoutes: [DASHBOARD_PAGE_HOST] },
            {
              component: './injections/Other.svelte',
              actions: './injections/other.actions.ts',
              hostRoutes: [DASHBOARD_PAGE_HOST],
            },
          ],
        },
      })
    )
    expect(result.messages.join('\n')).toContain(`action "${REGION}.share" is exported by both`)
  })

  it('notes (never fails) a host route whose server file the pack overrides, naming the requirement', async () => {
    const world = makeWorld({
      hostFiles: hostRegistry(),
      packFiles: files({ [DASHBOARD_SERVER]: 'export const load = () => ({})\n' }),
    })
    const result = await run(
      world,
      manifest({
        routes: {
          overrides: [{ path: DASHBOARD_SERVER, hostSha256: sha(world, DASHBOARD_SERVER) }],
        },
        injections: {
          [REGION]: [
            { component: `./${TILE}`, load: `./${LOAD}`, hostRoutes: [DASHBOARD_PAGE_HOST] },
          ],
        },
      })
    )
    expect(result.ok).toBe(true)
    const notes = result.plan.notes.join('\n')
    expect(notes).toContain(DASHBOARD_SERVER)
    expect(notes).toContain('withInjectedLoad')
  })

  it('against a web-host that predates hostRoutes: components-only works, an opt-in needs a newer web-host', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(null), packFiles: files() })
    const componentsOnly = await run(world, at(REGION, {}))
    expect(componentsOnly.messages).toEqual([])
    const optIn = await run(
      world,
      at(REGION, { load: `./${LOAD}`, hostRoutes: [DASHBOARD_PAGE_HOST] })
    )
    expect(optIn.ok).toBe(false)
    expect(optIn.messages.join('\n')).toContain('needs a newer web-host')
  })

  it('ignores hostRoutes on a point that a route file renders (its behavior already runs there), with a note', async () => {
    const world = makeWorld({ hostFiles: hostRegistry(), packFiles: files() })
    const result = await run(
      world,
      at('dashboard.home.after', { load: `./${LOAD}`, hostRoutes: [DASHBOARD_PAGE_HOST] })
    )
    expect(result.ok).toBe(true)
    expect(result.plan.notes.join('\n')).toContain('hostRoutes is ignored')
  })
})
