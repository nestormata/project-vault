import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { compose, type ComposeResult, type RunOptions } from '../src/compose.js'
import { LOCKFILE_VERSION } from '../src/lock.js'
import { makeWorld, manifest, useWorlds, writeAll, type World } from './compose-test-helpers.js'

/**
 * Story 68.14 AC-4 — the module pack's `apiRoutes.override` table recorded in
 * `composition.lock.json` (lockfileVersion 2): the pack entry is imported, `default.manifest` is
 * read, `hooksFactory()` is never called, and the section is sorted, normalized and compared by
 * `--check`.
 */
useWorlds()

const LOCK_FILE = 'composition.lock.json'
const EXTENSION_API_PATH = 'node_modules/@project-vault/extension-api/package.json'
const ENTRY = 'dist/index.js'
const DASHBOARD_WRAP = { method: 'GET', url: '/api/v1/dashboard', mode: 'wrap' }
const LOGIN_REPLACE = {
  method: 'POST',
  url: '/api/v1/auth/login',
  mode: 'replace',
  replaceSecurity: true,
  security: { requireAuth: false },
}
const DASHBOARD_LOCK = {
  method: 'GET',
  url: '/api/v1/dashboard',
  mode: 'wrap',
  replaceSecurity: false,
}
const LOGIN_LOCK = {
  method: 'POST',
  url: '/api/v1/auth/login',
  mode: 'replace',
  replaceSecurity: true,
}

type Global = { __kit68_14?: { imported: number; factoryCalls: number } }
const counters = globalThis as unknown as Global

function entrySource(apiRoutes: unknown, extra = ''): string {
  return `${extra}
globalThis.__kit68_14.imported += 1
export default {
  manifest: { name: 'test.pack', apiVersion: '3.25.0', capabilities: [], apiRoutes: ${JSON.stringify(apiRoutes)} },
  hooksFactory() {
    globalThis.__kit68_14.factoryCalls += 1
    throw new Error('hooksFactory must never be called by the kit')
  },
}
`
}

function modulePack(
  world: World,
  source: string,
  options: {
    name?: string
    packageJson?: Record<string, unknown> | null
    extensionApi?: string
  } = {}
): string {
  const dir = join(world.root, options.name ?? 'module-pack')
  const files: Record<string, string | null> = {
    [ENTRY]: source,
    [EXTENSION_API_PATH]: JSON.stringify({
      name: '@project-vault/extension-api',
      version: options.extensionApi ?? world.tuple.extensionApiVersion,
    }),
    'package.json':
      options.packageJson === null
        ? null
        : JSON.stringify({ type: 'module', main: ENTRY, ...options.packageJson }),
  }
  writeAll(dir, files)
  return dir
}

function run(world: World, extra: Partial<RunOptions> = {}): Promise<ComposeResult> {
  return compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: manifest(),
    ...extra,
  })
}

const lockOf = (world: World): Record<string, unknown> =>
  JSON.parse(readFileSync(join(world.app, LOCK_FILE), 'utf8')) as Record<string, unknown>

describe('apiRouteOverrides in the lock (Story 68.14 AC-4)', () => {
  beforeEach(() => {
    counters.__kit68_14 = { imported: 0, factoryCalls: 0 }
  })

  it('writes lockfileVersion 2 with sorted override objects and never calls hooksFactory', async () => {
    expect(LOCKFILE_VERSION).toBe(2)
    const world = makeWorld()
    const pack = modulePack(
      world,
      entrySource({
        override: [LOGIN_REPLACE, DASHBOARD_WRAP],
        add: [{ method: 'GET', url: '/cm/x' }],
      })
    )
    const result = await run(world, { modulePack: pack })
    expect(result.messages).toEqual([])
    const lock = lockOf(world)
    expect(lock['lockfileVersion']).toBe(2)
    expect(lock['apiRouteOverrides']).toEqual([DASHBOARD_LOCK, LOGIN_LOCK])
    expect(counters.__kit68_14).toEqual({ imported: 1, factoryCalls: 0 })
    expect(JSON.stringify(lock)).not.toContain('requireAuth')
    expect(JSON.stringify(lock)).not.toContain('/cm/x')
  })

  it('recomposing is byte-identical and a reorder of declarations does not change the lock', async () => {
    const world = makeWorld()
    const first = modulePack(world, entrySource({ override: [LOGIN_REPLACE, DASHBOARD_WRAP] }))
    await run(world, { modulePack: first })
    const text = readFileSync(join(world.app, LOCK_FILE), 'utf8')
    await run(world, { modulePack: first })
    expect(readFileSync(join(world.app, LOCK_FILE), 'utf8')).toBe(text)
    const reordered = modulePack(
      world,
      entrySource({ override: [DASHBOARD_WRAP, LOGIN_REPLACE] }),
      {
        name: 'reordered-pack',
      }
    )
    await run(world, { modulePack: reordered })
    expect(readFileSync(join(world.app, LOCK_FILE), 'utf8')).toBe(text)
  })

  it('normalizes the url like the host route key: leading slash, no trailing slash', async () => {
    const world = makeWorld()
    const pack = modulePack(
      world,
      entrySource({ override: [{ method: 'GET', url: '/api/v1/x/', mode: 'wrap' }] })
    )
    await run(world, { modulePack: pack })
    expect(lockOf(world)['apiRouteOverrides']).toEqual([
      { method: 'GET', url: '/api/v1/x', mode: 'wrap', replaceSecurity: false },
    ])
  })

  it('a pack with only adds, or no apiRoutes at all, records an empty table', async () => {
    const world = makeWorld()
    const addsOnly = modulePack(world, entrySource({ add: [{ method: 'GET', url: '/cm/x' }] }))
    const result = await run(world, { modulePack: addsOnly })
    expect(lockOf(world)['apiRouteOverrides']).toEqual([])
    expect(result.plan.notes.some((note) => note.includes('override'))).toBe(false)
    const bare = modulePack(world, entrySource(undefined), { name: 'bare-pack' })
    await run(world, { modulePack: bare })
    expect(lockOf(world)['apiRouteOverrides']).toEqual([])
  })

  it('without --module-pack: an empty table and the informational note', async () => {
    const world = makeWorld()
    const result = await run(world)
    expect(lockOf(world)['apiRouteOverrides']).toEqual([])
    expect(result.plan.notes).toContain('extension-api version not checked: no --module-pack given')
  })

  it('--check names apiRouteOverrides as drifted after the pack flips replaceSecurity', async () => {
    const world = makeWorld()
    const pack = modulePack(world, entrySource({ override: [DASHBOARD_WRAP] }))
    await run(world, { modulePack: pack })
    expect((await run(world, { modulePack: pack, check: true })).ok).toBe(true)
    const flipped = modulePack(
      world,
      entrySource({ override: [{ ...DASHBOARD_WRAP, replaceSecurity: true }] }),
      // A different directory: Node caches an imported module by URL for the life of the process.
      { name: 'flipped-pack' }
    )
    const checked = await run(world, { modulePack: flipped, check: true })
    expect(checked.ok).toBe(false)
    expect(checked.messages.join('\n')).toContain('apiRouteOverrides')
    expect(checked.messages.join('\n')).toContain('out of date (apiRouteOverrides)')
    expect(checked.messages.join('\n')).toContain('replaceSecurity')
  })

  it('a lock without a table in the pack but with --module-pack and overrides reports drift', async () => {
    const world = makeWorld()
    await run(world)
    const pack = modulePack(world, entrySource({ override: [DASHBOARD_WRAP] }))
    const checked = await run(world, { modulePack: pack, check: true })
    expect(checked.ok).toBe(false)
    expect(checked.messages.join('\n')).toContain('apiRouteOverrides')
  })
})

describe('the module pack entry is trusted but contained (Story 68.14 AC-4)', () => {
  beforeEach(() => {
    counters.__kit68_14 = { imported: 0, factoryCalls: 0 }
  })

  const failure = async (world: World, pack: string): Promise<string> => {
    const result = await run(world, { modulePack: pack })
    expect(result.ok).toBe(false)
    expect(existsSync(join(world.app, LOCK_FILE))).toBe(false)
    return result.messages.join('\n')
  }

  it('an entry that throws on import fails naming the pack and the error, lock untouched', async () => {
    const world = makeWorld()
    const pack = modulePack(world, `throw new RangeError('boom while reading config')`)
    const message = await failure(world, pack)
    expect(message).toContain('module pack')
    expect(message).toContain(pack)
    expect(message).toContain('RangeError: boom while reading config')
  })

  it('truncates the printed error message to 500 characters', async () => {
    const world = makeWorld()
    const long = 'x'.repeat(900)
    const pack = modulePack(world, `throw new Error('${long}')`)
    const message = await failure(world, pack)
    expect(message).toContain('x'.repeat(500))
    expect(message).not.toContain('x'.repeat(501))
  })

  it('a missing package.json, an unresolvable entry and a bare module each fail naming the pack', async () => {
    const world = makeWorld()
    const noPackageJson = modulePack(world, entrySource({}), { packageJson: null, name: 'no-json' })
    expect(await failure(world, noPackageJson)).toContain('no package.json')
    const noEntry = modulePack(world, entrySource({}), {
      name: 'no-entry',
      packageJson: { main: 'dist/missing.js' },
    })
    expect(await failure(world, noEntry)).toContain('entry dist/missing.js was not found')
    const bare = modulePack(world, 'export const x = 1\n', { name: 'bare' })
    expect(await failure(world, bare)).toContain('module pack entry has no default.manifest')
    const noMain = modulePack(world, entrySource({}), {
      name: 'no-main',
      packageJson: { main: undefined },
    })
    expect(await failure(world, noMain)).toContain('has no main or exports')
  })

  it('resolves exports["."] before main, including a conditions object', async () => {
    const world = makeWorld()
    const pack = modulePack(world, entrySource({ override: [DASHBOARD_WRAP] }), {
      packageJson: { main: 'dist/missing.js', exports: { '.': { import: `./${ENTRY}` } } },
    })
    expect((await run(world, { modulePack: pack })).ok).toBe(true)
    const string = modulePack(world, entrySource({ override: [DASHBOARD_WRAP] }), {
      name: 'string-exports',
      packageJson: { main: undefined, exports: `./${ENTRY}` },
    })
    expect((await run(world, { modulePack: string })).ok).toBe(true)
  })

  it('refuses an entry that is a symlink escaping the pack directory', async () => {
    const world = makeWorld()
    const outside = join(world.root, 'outside.js')
    writeFileSync(outside, entrySource({}))
    const pack = modulePack(world, '', { name: 'symlinked' })
    symlinkSync(outside, join(pack, 'dist', 'escape.js'))
    writeFileSync(
      join(pack, 'package.json'),
      JSON.stringify({ type: 'module', main: 'dist/escape.js' })
    )
    expect(await failure(world, pack)).toContain('resolves outside the module pack directory')
    expect(counters.__kit68_14?.imported).toBe(0)
  })

  it('the extension-api tuple check runs first: a mismatch fails before any import', async () => {
    const world = makeWorld()
    const pack = modulePack(world, entrySource({ override: [DASHBOARD_WRAP] }), {
      extensionApi: '3.99.0',
    })
    const message = await failure(world, pack)
    expect(message).toContain('Compatibility mismatch: @project-vault/extension-api')
    expect(counters.__kit68_14?.imported).toBe(0)
  })

  it('a malformed apiRoutes.override fails with its index', async () => {
    const world = makeWorld()
    const pack = modulePack(world, entrySource({ override: [{ method: 'GET' }] }))
    expect(await failure(world, pack)).toContain('apiRoutes.override[0]')
  })

  it('refuses a method the lock schema does not accept instead of writing an invalid lock', async () => {
    const world = makeWorld()
    const pack = modulePack(
      world,
      entrySource({ override: [{ method: 'get', url: '/x', mode: 'wrap' }] })
    )
    expect(await failure(world, pack)).toContain('apiRoutes.override[0].method must be one of')
  })
})

describe('lockfileVersion migration (Story 68.14 OQ-1)', () => {
  const v1Lock = async (world: World): Promise<string> => {
    await run(world)
    const lock = lockOf(world)
    const text = `${JSON.stringify({ ...lock, lockfileVersion: 1, apiRouteOverrides: [] }, null, 2)}\n`
    writeFileSync(join(world.app, LOCK_FILE), text)
    return text
  }

  it('--check on a v1 lock reports the version mismatch, not silent drift or a diff', async () => {
    const world = makeWorld()
    const text = await v1Lock(world)
    const checked = await run(world, { check: true })
    expect(checked.ok).toBe(false)
    expect(checked.messages).toHaveLength(1)
    expect(checked.messages[0]).toContain('lockfileVersion 1')
    expect(checked.messages[0]).toContain('lockfileVersion 2')
    expect(checked.messages[0]).toContain('run pv-compose')
    expect(checked.messages[0]).not.toContain('@@')
    expect(readFileSync(join(world.app, LOCK_FILE), 'utf8')).toBe(text)
  })

  it('recomposing rewrites a v1 lock as v2, logs the migration, and --check then passes', async () => {
    const world = makeWorld()
    await v1Lock(world)
    const lines: string[] = []
    const result = await run(world, { log: (line) => lines.push(line) })
    expect(result.ok).toBe(true)
    expect(
      lines.some((line) =>
        line.includes('migrating composition.lock.json from lockfileVersion 1 to 2')
      )
    ).toBe(true)
    expect(lockOf(world)['lockfileVersion']).toBe(2)
    expect((await run(world, { check: true })).ok).toBe(true)
  })

  it('a v2 recompose logs no migration line', async () => {
    const world = makeWorld()
    await run(world)
    const lines: string[] = []
    await run(world, { log: (line) => lines.push(line) })
    expect(lines.some((line) => line.includes('migrating'))).toBe(false)
  })

  it('a lock from a newer kit is still refused', async () => {
    const world = makeWorld()
    await run(world)
    writeFileSync(
      join(world.app, LOCK_FILE),
      JSON.stringify({ ...lockOf(world), lockfileVersion: 3 })
    )
    expect((await run(world, { check: true })).messages).toEqual([
      expect.stringContaining('newer kit'),
    ])
  })
})
