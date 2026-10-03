import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from './apply.js'
import { applyIncremental, signaturesOf } from './incremental.js'
import { plan } from './plan.js'
import {
  makeWorld,
  manifest,
  sha,
  useWorlds,
  writeAll,
  type World,
} from '../tests/compose-test-helpers.js'

const BILLING_PAGE = 'src/routes/billing/+page.svelte'

useWorlds()

const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'

async function planFor(world: World) {
  return plan({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: manifest({
      routes: { overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD) }] },
    }),
  })
}

describe('applyIncremental (AC-13: dev mode mirrors changes)', () => {
  it('rewrites only changed files and restores the PV file when an override is deleted', async () => {
    const world = makeWorld({ packFiles: { [DASHBOARD]: 'cm v1\n' } })
    const first = await planFor(world)
    apply(first, world.app)
    let state = signaturesOf(first)
    expect(readFileSync(join(world.app, DASHBOARD), 'utf8')).toBe('cm v1\n')

    writeFileSync(join(world.pack, DASHBOARD), 'cm v2 changed\n')
    utimesSync(join(world.pack, DASHBOARD), new Date(2030, 0, 1), new Date(2030, 0, 1))
    writeFileSync(join(world.app, 'src/lib/util.ts'), 'sentinel: untouched when unchanged\n')
    state = applyIncremental(await planFor(world), world.app, state)
    expect(readFileSync(join(world.app, DASHBOARD), 'utf8')).toBe('cm v2 changed\n')
    expect(readFileSync(join(world.app, 'src/lib/util.ts'), 'utf8')).toContain('sentinel')

    // Deleting the override restores the PV file (the manifest would now fail AC-3, so drop it too).
    rmSync(join(world.pack, DASHBOARD))
    const restored = await plan({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: manifest(),
    })
    state = applyIncremental(restored, world.app, state)
    expect(readFileSync(join(world.app, DASHBOARD), 'utf8')).toBe('<h1>Dashboard</h1>\n')
    expect(state.has(DASHBOARD)).toBe(true)
  })

  // Story 68.5 AC-2/AC-7: the replacement map follows the manifest in dev mode, and the CM file of
  // a removed replacement leaves with it.
  it('refreshes the replacement map when a replacement is added or removed', async () => {
    const world = makeWorld({ packFiles: { 'r/Search.svelte': '<input />\n' } })
    const options = { appRoot: world.app, packRoot: world.pack, hostDir: world.host }
    const base = await plan({ ...options, manifest: manifest() })
    apply(base, world.app)
    const mapPath = join(world.app, '.pv-compose/replacements.json')
    expect(JSON.parse(readFileSync(mapPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      replacements: [],
    })
    let state = signaturesOf(base)

    const target = 'src/lib/components/shell/GlobalSearch.svelte'
    const withReplacement = manifest({
      replacements: {
        '$lib/components/shell/GlobalSearch.svelte': {
          with: './r/Search.svelte',
          hostSha256: sha(world, target),
        },
      },
    })
    state = applyIncremental(
      await plan({ ...options, manifest: withReplacement }),
      world.app,
      state
    )
    expect(readFileSync(mapPath, 'utf8')).toContain('"with": "src/lib/_cm/r/Search.svelte"')
    expect(existsSync(join(world.app, 'src/lib/_cm/r/Search.svelte'))).toBe(true)

    state = applyIncremental(await plan({ ...options, manifest: manifest() }), world.app, state)
    expect(JSON.parse(readFileSync(mapPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      replacements: [],
    })
    expect(existsSync(join(world.app, 'src/lib/_cm/r/Search.svelte'))).toBe(false)
    expect(state.size).toBeGreaterThan(0)
  })

  it('adds new pack files (M2) and removes files that left the plan', async () => {
    const world = makeWorld({ packFiles: { [BILLING_PAGE]: 'b\n' } })
    const base = await plan({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: manifest(),
    })
    apply(base, world.app)
    let state = signaturesOf(base)
    writeAll(world.pack, { 'src/routes/reports/+page.svelte': 'r\n' })
    rmSync(join(world.pack, BILLING_PAGE))
    const next = await plan({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: manifest(),
    })
    state = applyIncremental(next, world.app, state)
    expect(existsSync(join(world.app, 'src/routes/reports/+page.svelte'))).toBe(true)
    expect(existsSync(join(world.app, BILLING_PAGE))).toBe(false)
    expect(state.has(BILLING_PAGE)).toBe(false)
  })
})
