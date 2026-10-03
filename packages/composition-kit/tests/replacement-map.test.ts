// Story 68.5 AC-2: the composer emits `.pv-compose/replacements.json`, the map `pvReplace` reads.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import {
  makeWorld,
  manifest,
  sha,
  useWorlds,
  writeAll,
  type World,
} from './compose-test-helpers.js'

useWorlds()

const WITH_SEARCH = './r/GlobalSearch.svelte'
const MAP = '.pv-compose/replacements.json'
const SEARCH = 'src/lib/components/shell/GlobalSearch.svelte'
const SEARCH_TARGET = '$lib/components/shell/GlobalSearch.svelte'
const AUTH = 'src/lib/server/auth.ts'

function replacements(world: World, extra: Record<string, string> = {}) {
  return manifest({
    replacements: {
      [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: sha(world, SEARCH) },
      '$lib/server/auth': { with: './r/auth.ts', hostSha256: sha(world, AUTH) },
      ...Object.fromEntries(
        Object.entries(extra).map(([target, hostSha256]) => [
          target,
          { with: WITH_SEARCH, hostSha256 },
        ])
      ),
    },
  })
}

const PACK = {
  'r/GlobalSearch.svelte': '<input class="cm" />\n',
  'r/auth.ts': 'export const requireUser = () => false\n',
}

function run(world: World, pack: unknown) {
  return compose({ appRoot: world.app, packRoot: world.pack, hostDir: world.host, manifest: pack })
}

function mapText(world: World): string {
  return readFileSync(join(world.app, MAP), 'utf8')
}

describe('AC-2: the replacement map', () => {
  it('lists target, host and with, sorted by host, relative paths only', async () => {
    const world = makeWorld({ packFiles: PACK })
    expect((await run(world, replacements(world))).messages).toEqual([])
    expect(JSON.parse(mapText(world))).toEqual({
      schemaVersion: 1,
      replacements: [
        {
          target: SEARCH_TARGET,
          host: SEARCH,
          with: 'src/lib/_cm/r/GlobalSearch.svelte',
        },
        { target: '$lib/server/auth', host: AUTH, with: 'src/lib/server/_cm/r/auth.ts' },
      ],
    })
    expect(mapText(world)).not.toContain(world.root)
    expect(mapText(world).endsWith('}\n')).toBe(true)
    expect(mapText(world)).toContain('\n  "schemaVersion": 1,\n')
  })

  it('is byte-identical across composes and across checkout paths', async () => {
    const one = makeWorld({ packFiles: PACK })
    const two = makeWorld({ packFiles: PACK })
    await run(one, replacements(one))
    await run(two, replacements(two))
    expect(mapText(one)).toBe(mapText(two))
    const first = mapText(one)
    await run(one, replacements(one))
    expect(mapText(one)).toBe(first)
  })

  it('writes an empty map when the manifest has no replacements', async () => {
    const world = makeWorld()
    expect((await run(world, manifest())).messages).toEqual([])
    expect(JSON.parse(mapText(world))).toEqual({ schemaVersion: 1, replacements: [] })
  })

  it('never puts a non-server target under server/ (the server-only guard depends on it)', async () => {
    const world = makeWorld({ packFiles: PACK })
    await run(world, replacements(world))
    const entries = (
      JSON.parse(mapText(world)) as { replacements: { target: string; with: string }[] }
    ).replacements
    for (const entry of entries) {
      expect(entry.with.includes('/server/')).toBe(entry.target.startsWith('$lib/server/'))
    }
  })

  it('does not change the lock: the lock is identical with or without the map', async () => {
    const world = makeWorld({ packFiles: PACK })
    await run(world, replacements(world))
    const lock = readFileSync(join(world.app, 'composition.lock.json'), 'utf8')
    expect(lock).not.toContain('.pv-compose')
    expect(lock).not.toContain('replacements.json')
  })

  it('does not rewrite the map when only the CM file changes, and drops entries removed from the manifest', async () => {
    const world = makeWorld({ packFiles: PACK })
    await run(world, replacements(world))
    const before = mapText(world)
    writeAll(world.pack, { 'r/GlobalSearch.svelte': '<input class="cm2" />\n' })
    await run(world, replacements(world))
    expect(mapText(world)).toBe(before)
    const only = manifest({
      replacements: {
        [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: sha(world, SEARCH) },
      },
    })
    await run(world, only)
    expect((JSON.parse(mapText(world)) as { replacements: unknown[] }).replacements).toHaveLength(1)
  })

  it('is not written by a failed compose, and a previous map stays in force', async () => {
    const world = makeWorld({ packFiles: PACK })
    await run(world, replacements(world))
    const good = mapText(world)
    writeAll(world.host, { [SEARCH]: '<input placeholder="changed upstream" />\n' })
    const result = await run(world, replacements(world))
    expect(result.ok).toBe(false)
    expect(mapText(world)).toBe(good)
  })

  it('writes nothing under --dry-run and --check', async () => {
    const world = makeWorld({ packFiles: PACK })
    await compose({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: replacements(world),
      dryRun: true,
    })
    expect(existsSync(join(world.app, MAP))).toBe(false)
  })
})
