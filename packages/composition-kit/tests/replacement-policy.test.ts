// Story 68.5 AC-6, AC-9, AC-13: replacements are hash-locked and described by the lock and the map
// alike; stability is a SIGNAL (informational notes) and nothing narrows what may be replaced.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import {
  makeWorld,
  manifest,
  shaOf,
  useWorlds,
  writeAll,
  type World,
} from './compose-test-helpers.js'

useWorlds()

const WITH_SEARCH = './r/Search.svelte'
const SEARCH_SHA = shaOf('<input placeholder="search" />\n')
const SEARCH = 'src/lib/components/shell/GlobalSearch.svelte'
const SEARCH_TARGET = '$lib/components/shell/GlobalSearch.svelte'
const STABLE_NOTE = `replacement ${SEARCH_TARGET}: stable`

function indexOf(stability: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    components: [{ path: SEARCH, stability, hash: 'x' }],
  })
}

function run(world: World, pack: unknown, extra: { check?: boolean } = {}) {
  return compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: pack,
    ...extra,
  })
}

function lockOf(world: World): {
  replacements: { target: string; with: string }[]
  materialized: { path: string; source: string }[]
  notes: string[]
} {
  return JSON.parse(readFileSync(join(world.app, 'composition.lock.json'), 'utf8'))
}

describe('AC-9: stability is a signal recorded as informational notes', () => {
  it('notes a stable replacement, still composes, and `--check` ignores notes', async () => {
    const world = makeWorld({
      packFiles: { 'r/Search.svelte': '<input />\n' },
      hostFiles: { 'manifests/component-index.json': indexOf('stable') },
    })
    const pack = manifest({
      replacements: {
        [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: SEARCH_SHA },
      },
    })
    const result = await run(world, pack)
    expect(result.messages).toEqual([])
    expect(lockOf(world).notes).toContain(STABLE_NOTE)
    expect(result.plan.notes).toContain(STABLE_NOTE)
    // The index changes (stability flips): the lock differs only in notes, which --check ignores.
    writeAll(world.host, { 'manifests/component-index.json': indexOf('unmarked') })
    expect((await run(world, pack, { check: true })).ok).toBe(true)
  })

  it('records unmarked, "not in the index" and server-side modules', async () => {
    const world = makeWorld({
      packFiles: {
        'r/Search.svelte': '<input />\n',
        'r/auth.ts': 'export const requireUser = () => 1\n',
      },
      hostFiles: {
        'manifests/component-index.json': JSON.stringify({ schemaVersion: 1, components: [] }),
      },
    })
    const pack = manifest({
      replacements: {
        [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: SEARCH_SHA },
        '$lib/server/auth': {
          with: './r/auth.ts',
          hostSha256: shaOf('export const requireUser = () => true\n'),
        },
      },
    })
    expect((await run(world, pack)).messages).toEqual([])
    const notes = lockOf(world).notes
    expect(notes).toContain(
      `replacement ${SEARCH_TARGET}: not in manifests/component-index.json (no stability signal)`
    )
    expect(notes).toContain('replacement $lib/server/auth: server-side module')
  })

  it('adds no stability note when the host ships no index', async () => {
    const world = makeWorld({ packFiles: { 'r/Search.svelte': '<input />\n' } })
    const pack = manifest({
      replacements: {
        [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: SEARCH_SHA },
      },
    })
    await run(world, pack)
    expect(
      lockOf(world).notes.filter((note) => /: (?:stable|unmarked)$|component-index/.test(note))
    ).toEqual([])
  })
})

describe('AC-6: the lock and the map describe the same replacements', () => {
  it('lists every map entry in the lock, with its with-file materialized', async () => {
    const world = makeWorld({
      packFiles: {
        'r/Search.svelte': '<input />\n',
        'r/auth.ts': 'export const requireUser = () => 1\n',
      },
    })
    const pack = manifest({
      replacements: {
        [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: SEARCH_SHA },
        '$lib/server/auth': {
          with: './r/auth.ts',
          hostSha256: shaOf('export const requireUser = () => true\n'),
        },
      },
    })
    expect((await run(world, pack)).messages).toEqual([])
    const lock = lockOf(world)
    const map = JSON.parse(
      readFileSync(join(world.app, '.pv-compose/replacements.json'), 'utf8')
    ) as {
      replacements: { target: string; with: string }[]
    }
    expect(map.replacements.map((entry) => entry.target).sort()).toEqual(
      lock.replacements.map((entry) => entry.target).sort()
    )
    const materialized = new Set(lock.materialized.map((entry) => entry.path))
    for (const entry of map.replacements) expect(materialized.has(entry.with)).toBe(true)
  })

  it('fails a wrong hostSha256 naming the target and printing the drift', async () => {
    const world = makeWorld({ packFiles: { 'r/Search.svelte': '<input />\n' } })
    const pack = manifest({
      replacements: { [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: 'c'.repeat(64) } },
    })
    const result = await run(world, pack)
    expect(result.ok).toBe(false)
    expect(result.messages.join('\n')).toContain(`DRIFT ${SEARCH_TARGET} (replacement)`)
  })
})

describe('AC-13: nothing narrows what a replacement may name', () => {
  const FILES: Record<string, string> = {}
  for (let index = 0; index < 30; index++) {
    const area =
      ['components/a', 'components/b', 'server', 'api', 'state', 'util'][index % 6] ?? 'util'
    const ext = area.startsWith('components') ? 'svelte' : 'ts'
    FILES[`src/lib/${area}/file${index}.${ext}`] =
      ext === 'svelte' ? `<p>${index}</p>\n` : `export const v${index} = ${index}\n`
  }

  // A seeded (deterministic) pseudo-random pick, so a failure reproduces.
  function pick(paths: string[], count: number, seed: number): string[] {
    let state = seed
    const pool = [...paths]
    const chosen: string[] = []
    while (chosen.length < count && pool.length > 0) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      chosen.push(...pool.splice(state % pool.length, 1))
    }
    return chosen
  }

  it('composes replacements of 20 seeded-random src/lib files, server and api modules included', async () => {
    const paths = Object.keys(FILES)
    const chosen = pick(paths, 20, 68_005)
    const forced = ['src/lib/server/file2.ts', 'src/lib/api/file3.ts']
    for (const path of forced) if (!chosen.includes(path)) chosen.push(path)
    const packFiles: Record<string, string> = {}
    const replacements: Record<string, { with: string; hostSha256: string }> = {}
    for (const path of chosen) {
      const withPath = `r/${path.replaceAll('/', '_')}`
      packFiles[withPath] = path.endsWith('.svelte') ? '<p>cm</p>\n' : 'export const cm = 1\n'
      replacements[`$lib/${path.slice('src/lib/'.length)}`] = {
        with: `./${withPath}`,
        hostSha256: shaOf(FILES[path] ?? ''),
      }
    }
    const world = makeWorld({ packFiles, hostFiles: FILES })
    const result = await run(world, manifest({ replacements }))
    expect(result.messages).toEqual([])
    expect(lockOf(world).replacements).toHaveLength(chosen.length)
  })

  it('replaces a @pv-stable component and an unmarked one alike', async () => {
    const world = makeWorld({
      packFiles: { 'r/Search.svelte': '<input />\n', 'r/util.ts': 'export const fmt = () => 1\n' },
      hostFiles: { 'manifests/component-index.json': indexOf('stable') },
    })
    const pack = manifest({
      replacements: {
        [SEARCH_TARGET]: { with: WITH_SEARCH, hostSha256: SEARCH_SHA },
        '$lib/util.ts': {
          with: './r/util.ts',
          hostSha256: shaOf('export const fmt = (n: number) => String(n)\n'),
        },
      },
    })
    expect((await run(world, pack)).messages).toEqual([])
  })

  it('replaces a component together with a module it imports (the map is consulted per import)', async () => {
    const world = makeWorld({
      packFiles: { 'r/Search.svelte': '<input />\n', 'r/util.ts': 'export const fmt = () => 1\n' },
      hostFiles: {
        'src/lib/components/shell/GlobalSearch.svelte':
          '<script>import { fmt } from "$lib/util.ts"</script>{fmt(1)}\n',
      },
    })
    const pack = manifest({
      replacements: {
        [SEARCH_TARGET]: {
          with: WITH_SEARCH,
          hostSha256: shaOf('<script>import { fmt } from "$lib/util.ts"</script>{fmt(1)}\n'),
        },
        '$lib/util.ts': {
          with: './r/util.ts',
          hostSha256: shaOf('export const fmt = (n: number) => String(n)\n'),
        },
      },
    })
    expect((await run(world, pack)).messages).toEqual([])
  })
})
