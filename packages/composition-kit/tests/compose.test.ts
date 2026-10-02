import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose, type ComposeResult, type RunOptions } from '../src/compose.js'
import {
  HOST_FILES,
  hostBytes,
  makeWorld,
  manifest,
  sha,
  shaOf,
  useWorlds,
  writeAll,
  type World,
} from './compose-test-helpers.js'

const CM_DASHBOARD = '<h1>CM dashboard</h1>\n'
const BILLING_PAGE = 'src/routes/billing/+page.svelte'
const BILLING_HTML = '<h1>Billing</h1>\n'
const LOGIN_PAGE = 'src/routes/login/+page.svelte'
const LOGIN_HTML = '<h1>Login</h1>\n'
const LOCK_FILE = 'composition.lock.json'
const FAVICON = 'static/favicon.png'
const PANELS_ID = '/(app)/extensions/panels'
const REPLACEMENT_WITH = './replacements/GlobalSearch.svelte'
const REPLACEMENT_FILE = 'replacements/GlobalSearch.svelte'
const DASHBOARD_V2 = '<h1>Dashboard v2</h1>\n'
const STORY_E5 = 'CM-E16.5'
const INPUT_HTML = '<input class="cm" />\n'

useWorlds()

function run(world: World, pack: unknown, extra: Partial<RunOptions> = {}): Promise<ComposeResult> {
  return compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: pack,
    ...extra,
  })
}

function listFiles(root: string, dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) listFiles(root, rel, into)
    else into.push(rel)
  }
  return into.sort()
}

function read(world: World, rel: string): string {
  return readFileSync(join(world.app, rel), 'utf8')
}

const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'

function dashboardOverride(world: World): { world: World; pack: ReturnType<typeof manifest> } {
  return {
    world,
    pack: manifest({
      routes: {
        overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD), story: 'CM-E16.3' }],
      },
    }),
  }
}

describe('AC-2/AC-3: copy, overlay, override and addition', () => {
  it('composes the host, overrides one file, adds M2 routes and writes a lock', async () => {
    const world = makeWorld({
      packFiles: {
        [DASHBOARD]: CM_DASHBOARD,
        [BILLING_PAGE]: BILLING_HTML,
        'src/routes/(app)/projects/[projectId]/new-tab/+page.svelte': '<p>deep</p>\n',
      },
    })
    const pack = manifest({
      routes: {
        overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD), story: 'CM-E16.3' }],
      },
    })
    const result = await run(world, pack)
    expect(result.messages).toEqual([])
    expect(result.ok).toBe(true)
    expect(read(world, DASHBOARD)).toBe(CM_DASHBOARD)
    expect(read(world, BILLING_PAGE)).toBe(BILLING_HTML)
    expect(read(world, LOGIN_PAGE)).toBe(LOGIN_HTML)
    const hostSrc = Object.keys(HOST_FILES).filter((path) => path.startsWith('src/'))
    const composedSrc = listFiles(world.app, 'src').filter((path) => !path.includes('/.'))
    expect(composedSrc).toEqual(
      [
        ...hostSrc,
        BILLING_PAGE,
        'src/routes/(app)/projects/[projectId]/new-tab/+page.svelte',
      ].sort()
    )
    const lock = JSON.parse(read(world, LOCK_FILE)) as Record<string, unknown>
    expect(lock.overrides).toEqual([
      {
        path: DASHBOARD,
        hostSha256: sha(world, DASHBOARD),
        cmSha256: shaOf(CM_DASHBOARD),
        story: 'CM-E16.3',
        hostVersion: '1.5.0',
      },
    ])
    expect((lock.additions as { path: string }[]).map((e) => e.path)).toEqual([
      'src/routes/(app)/projects/[projectId]/new-tab/+page.svelte',
      BILLING_PAGE,
    ])
    expect(lock.excludedPvTests).toEqual([])
    expect(lock.apiRouteOverrides).toEqual([])
  })

  it('copies regular files only, writes a do-not-edit header and a gitignore in each generated directory', async () => {
    const world = makeWorld()
    await run(world, manifest())
    for (const dir of ['src', 'static', 'messages', 'project.inlang', 'vendor']) {
      expect(read(world, `${dir}/.pv-compose-generated`)).toContain('DO NOT EDIT')
      expect(read(world, `${dir}/.gitignore`)).toBe('*\n')
    }
    for (const file of listFiles(world.app, 'src'))
      expect(lstatSync(join(world.app, file)).isFile()).toBe(true)
  })

  it('is idempotent and removes a file web-host dropped', async () => {
    const world = makeWorld()
    await run(world, manifest())
    const first = readFileSync(join(world.app, LOCK_FILE), 'utf8')
    const before = listFiles(world.app, 'src')
    await run(world, manifest())
    expect(readFileSync(join(world.app, LOCK_FILE), 'utf8')).toBe(first)
    expect(listFiles(world.app, 'src')).toEqual(before)
    const { rmSync } = await import('node:fs')
    rmSync(join(world.host, LOGIN_PAGE))
    await run(world, manifest())
    expect(existsSync(join(world.app, LOGIN_PAGE))).toBe(false)
  })

  it('fails an undeclared collision, names the hash, and leaves the previous tree intact', async () => {
    const world = makeWorld({ packFiles: { [LOGIN_PAGE]: '<h1>CM login</h1>\n' } })
    const good = makeWorld()
    await run(good, manifest())
    writeAll(world.app, { 'src/previous.txt': 'x', 'src/.pv-compose-generated': 'x' })
    const result = await run(world, manifest())
    const hash = sha(world, LOGIN_PAGE)
    expect(result.ok).toBe(false)
    expect(result.messages).toEqual([
      `Collision: src/routes/login/+page.svelte exists in web-host (sha256 ${hash}) but is not declared in routes.overrides. Declare it with hostSha256 "${hash}" to override it.`,
    ])
    expect(read(world, 'src/previous.txt')).toBe('x')
    expect(existsSync(join(world.app, LOCK_FILE))).toBe(false)
  })

  it('fails a declared override the pack does not contain, or web-host does not have', async () => {
    const world = makeWorld({ packFiles: { 'src/routes/new/+page.svelte': 'x\n' } })
    const result = await run(
      world,
      manifest({
        routes: {
          overrides: [
            { path: 'src/routes/missing/+page.svelte', hostSha256: 'a'.repeat(64) },
            { path: 'src/routes/new/+page.svelte', hostSha256: 'a'.repeat(64) },
          ],
        },
      })
    )
    expect(result.messages).toEqual([
      'Override declared for src/routes/missing/+page.svelte but the UI pack has no such file (check the path).',
      expect.stringContaining(
        'Override declared for src/routes/new/+page.svelte but web-host has no such file'
      ),
    ])
  })

  it('reports a stale declared hash as drift with the diff, not as a collision', async () => {
    const world = makeWorld({ packFiles: { [DASHBOARD]: CM_DASHBOARD } })
    const result = await run(
      world,
      manifest({
        routes: { overrides: [{ path: DASHBOARD, hostSha256: 'b'.repeat(64), story: 'CM-E16.3' }] },
      })
    )
    expect(result.ok).toBe(false)
    const [report] = result.messages
    expect(report).toContain(`DRIFT ${DASHBOARD} (override, story CM-E16.3)`)
    expect(report).toContain(
      `declared hostSha256: ${'b'.repeat(64)}   web-host sha256: ${sha(world, DASHBOARD)}`
    )
    expect(report).toContain('accepted at PV 1.5.0, host is PV 1.5.0')
    expect(report).toContain('-<h1>CM dashboard</h1>')
    expect(report).toContain('+<h1>Dashboard</h1>')
  })

  it('refuses a symlink in web-host or in the pack, naming it', async () => {
    const world = makeWorld({ packFiles: { 'src/a.txt': 'a' } })
    symlinkSync('/etc/hostname', join(world.host, 'src', 'link'))
    symlinkSync('/etc/hostname', join(world.pack, 'src', 'plink'))
    const result = await run(world, manifest())
    expect(result.ok).toBe(false)
    expect(result.messages).toEqual([
      expect.stringContaining('Refusing symlink in the UI pack: src/plink -> /etc/hostname'),
      expect.stringContaining('Refusing symlink in web-host: src/link -> /etc/hostname'),
    ])
  })

  it('refuses a directory that is not a web-host package before touching the target', async () => {
    const world = makeWorld()
    const result = await run(world, manifest(), { hostDir: world.pack })
    expect(result.messages).toEqual([
      expect.stringContaining('not a web-host package (missing manifests/compatibility.json)'),
    ])
    expect(existsSync(join(world.app, 'src'))).toBe(false)
  })

  it('refuses overlapping input and output', async () => {
    const world = makeWorld()
    expect((await run(world, manifest(), { appRoot: world.pack })).messages).toEqual([
      expect.stringContaining('the same directory'),
    ])
    const inside = join(world.host, 'app')
    mkdirSync(inside)
    writeFileSync(join(inside, 'package.json'), '{}')
    expect((await run(world, manifest(), { appRoot: inside })).messages).toEqual([
      expect.stringContaining('is inside'),
    ])
  })

  it('refuses a generated directory that was hand-edited (no header) instead of wiping it', async () => {
    const world = makeWorld()
    writeAll(world.app, { 'src/mine.ts': 'precious' })
    const result = await run(world, manifest())
    expect(result.messages).toEqual([expect.stringContaining('Refusing to replace')])
    expect(read(world, 'src/mine.ts')).toBe('precious')
  })

  it('refuses an app root with no package.json or a home directory', async () => {
    const world = makeWorld()
    const bare = join(world.root, 'bare')
    mkdirSync(bare)
    expect((await run(world, manifest(), { appRoot: bare })).messages).toEqual([
      expect.stringContaining('not an app root'),
    ])
  })

  it('refuses a reserved _cm namespace in web-host or the pack', async () => {
    const world = makeWorld({
      hostFiles: { 'src/lib/_cm/x.ts': 'x' },
      packFiles: { 'src/lib/server/_cm/y.ts': 'y' },
    })
    const result = await run(world, manifest())
    expect(result.messages).toEqual([
      expect.stringContaining('src/lib/_cm/x.ts'),
      expect.stringContaining('src/lib/server/_cm/y.ts'),
    ])
  })

  it('refuses two pack paths that differ only by case', async () => {
    const world = makeWorld({
      packFiles: { 'src/routes/A/+page.svelte': 'a', 'src/routes/a/+page.svelte': 'b' },
    })
    const result = await run(world, manifest())
    expect(result.messages).toEqual([
      expect.stringContaining(
        'Case collision: src/routes/A/+page.svelte and src/routes/a/+page.svelte'
      ),
    ])
  })

  it('--dry-run writes nothing', async () => {
    const world = makeWorld({ packFiles: { [BILLING_PAGE]: 'b\n' } })
    const result = await run(world, manifest(), { dryRun: true })
    expect(result.ok).toBe(true)
    expect(result.written).toBe(false)
    expect(existsSync(join(world.app, 'src'))).toBe(false)
    expect(result.plan.summary.additions).toBe(1)
  })

  it('records binary static overrides by raw-byte hash', async () => {
    const world = makeWorld({ packFiles: { [FAVICON]: Buffer.from([1, 2, 3, 4]) } })
    const result = await run(
      world,
      manifest({ routes: { overrides: [{ path: FAVICON, hostSha256: sha(world, FAVICON) }] } })
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(world.app, FAVICON))).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(result.plan.notes).toContain('override static/favicon.png has no story')
  })
})

describe('AC-3/AC-7: nothing is an allowlist (M1-M7)', () => {
  const PATHS = [
    'src/hooks.server.ts',
    'src/app.html',
    'src/lib/server/auth.ts',
    'src/routes/api/v1/[...path]/+server.ts',
    FAVICON,
    'src/routes/(app)/extensions/panels/[slot]/[...subpath]/+page.svelte',
    'src/routes/+layout.svelte',
    'src/lib/util.ts',
  ]

  it.each(PATHS)('overrides %s', async (path) => {
    const world = makeWorld({ packFiles: { [path]: 'cm replacement\n' } })
    const result = await run(
      world,
      manifest({ routes: { overrides: [{ path, hostSha256: sha(world, path), story: 's' }] } })
    )
    expect(result.messages).toEqual([])
    expect(read(world, path)).toBe('cm replacement\n')
  })

  it.each(PATHS)('removes %s', async (path) => {
    const world = makeWorld()
    const result = await run(world, manifest({ routes: { remove: [path] } }))
    expect(result.messages).toEqual([])
    expect(existsSync(join(world.app, path))).toBe(false)
  })

  it('overrides and removes a random existing host path (seeded, printed on failure)', async () => {
    const seed = 20261002
    const candidates = Object.keys(HOST_FILES).filter(
      (p) => p.startsWith('src/') || p.startsWith('static/')
    )
    const pick = candidates[seed % candidates.length] ?? ''
    const world = makeWorld({ packFiles: { [pick]: 'x\n' } })
    const overridden = await run(
      world,
      manifest({ routes: { overrides: [{ path: pick, hostSha256: sha(world, pick) }] } })
    )
    expect(overridden.ok, `seed ${seed} path ${pick}`).toBe(true)
    const removed = await run(makeWorld(), manifest({ routes: { remove: [pick] } }))
    expect(removed.ok, `seed ${seed} path ${pick}`).toBe(true)
  })
})

describe('AC-4: removals', () => {
  it('removes a route id subtree, including the frozen legacy panel route, and records hashes', async () => {
    const world = makeWorld()
    const result = await run(world, manifest({ routes: { remove: [PANELS_ID] } }))
    expect(result.ok).toBe(true)
    expect(existsSync(join(world.app, 'src/routes/(app)/extensions'))).toBe(false)
    const lock = JSON.parse(read(world, LOCK_FILE)) as { removals: Record<string, unknown>[] }
    expect(lock.removals).toEqual([
      {
        path: PANELS_ID,
        matched: 1,
        hostSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        hostVersion: '1.5.0',
        files: ['src/routes/(app)/extensions/panels/[slot]/[...subpath]/+page.svelte'],
      },
    ])
  })

  it('removes a file added to a removed route later and notes that the id gained a file', async () => {
    const world = makeWorld()
    await run(world, manifest({ routes: { remove: [PANELS_ID] } }))
    writeAll(world.host, { 'src/routes/(app)/extensions/panels/new/+page.svelte': 'new\n' })
    const result = await run(world, manifest({ routes: { remove: [PANELS_ID] } }))
    expect(result.ok).toBe(true)
    expect(existsSync(join(world.app, 'src/routes/(app)/extensions/panels/new/+page.svelte'))).toBe(
      false
    )
    expect(result.plan.notes).toContainEqual(expect.stringContaining('gained a file'))
  })

  it('treats a removal that matches nothing as informational', async () => {
    const world = makeWorld()
    const result = await run(world, manifest({ routes: { remove: ['/gone', 'static/gone.png'] } }))
    expect(result.ok).toBe(true)
    const lock = JSON.parse(read(world, LOCK_FILE)) as { removals: { matched: number }[] }
    expect(lock.removals.map((entry) => entry.matched)).toEqual([0, 0])
  })

  it('fails a removal that is neither a route id nor a file', async () => {
    const world = makeWorld()
    const result = await run(world, manifest({ routes: { remove: ['login'] } }))
    expect(result.messages).toEqual([expect.stringContaining('neither a route id')])
  })

  it('fails a contradiction: an overlay file or declared override under a removed id', async () => {
    const world = makeWorld({ packFiles: { 'src/routes/login/extra/+page.svelte': 'x\n' } })
    const result = await run(world, manifest({ routes: { remove: ['/login'] } }))
    expect(result.messages).toEqual([
      expect.stringContaining('Contradiction: src/routes/login/extra/+page.svelte'),
    ])
    const world2 = makeWorld({ packFiles: { [LOGIN_PAGE]: 'x\n' } })
    const declared = await run(
      world2,
      manifest({
        routes: {
          remove: ['/login'],
          overrides: [{ path: LOGIN_PAGE, hostSha256: sha(world2, LOGIN_PAGE) }],
        },
      })
    )
    expect(declared.messages.join('\n')).toContain('Contradiction: src/routes/login/+page.svelte')
  })

  it('allows removing hooks.server.ts without special-casing it', async () => {
    const world = makeWorld()
    expect((await run(world, manifest({ routes: { remove: ['src/hooks.server.ts'] } }))).ok).toBe(
      true
    )
  })
})

describe('AC-6: replacements', () => {
  const TARGET = '$lib/components/shell/GlobalSearch.svelte'
  const HOST_PATH = 'src/lib/components/shell/GlobalSearch.svelte'

  function replace(world: World, target = TARGET) {
    return manifest({
      replacements: {
        [target]: { with: REPLACEMENT_WITH, hostSha256: sha(world, HOST_PATH), story: STORY_E5 },
      },
    })
  }

  it('records the replacement, materializes the file and leaves the PV file untouched', async () => {
    const world = makeWorld({ packFiles: { [REPLACEMENT_FILE]: INPUT_HTML } })
    const result = await run(world, replace(world))
    expect(result.messages).toEqual([])
    expect(read(world, 'src/lib/_cm/replacements/GlobalSearch.svelte')).toBe(INPUT_HTML)
    expect(read(world, HOST_PATH)).toBe(hostBytes(HOST_PATH))
    const lock = JSON.parse(read(world, LOCK_FILE)) as { replacements: unknown[] }
    expect(lock.replacements).toEqual([
      {
        target: TARGET,
        with: REPLACEMENT_FILE,
        hostSha256: sha(world, HOST_PATH),
        cmSha256: shaOf(INPUT_HTML),
        story: STORY_E5,
        hostVersion: '1.5.0',
      },
    ])
  })

  it('resolves an extension-less target and puts a $lib/server replacement under server/_cm', async () => {
    const world = makeWorld({
      packFiles: {
        [REPLACEMENT_FILE]: 'x\n',
        'replacements/auth.ts': 'export const requireUser = () => false\n',
      },
    })
    const pack = manifest({
      replacements: {
        '$lib/components/shell/GlobalSearch': {
          with: REPLACEMENT_WITH,
          hostSha256: sha(world, HOST_PATH),
        },
        '$lib/server/auth': {
          with: './replacements/auth.ts',
          hostSha256: sha(world, 'src/lib/server/auth.ts'),
        },
      },
    })
    const result = await run(world, pack)
    expect(result.messages).toEqual([])
    expect(existsSync(join(world.app, 'src/lib/server/_cm/replacements/auth.ts'))).toBe(true)
    expect(existsSync(join(world.app, 'src/lib/_cm/replacements/GlobalSearch.svelte'))).toBe(true)
  })

  it('fails when the same file is both overridden and replaced', async () => {
    const world = makeWorld({ packFiles: { [REPLACEMENT_FILE]: 'x\n', [HOST_PATH]: 'y\n' } })
    const pack = {
      ...replace(world),
      routes: { overrides: [{ path: HOST_PATH, hostSha256: sha(world, HOST_PATH) }] },
    }
    const result = await run(world, pack)
    expect(result.messages).toEqual([
      `Conflict: ${HOST_PATH} is both overlaid (routes.overrides) and replaced (replacements ${TARGET}). Choose one.`,
    ])
  })

  it('fails a missing target, a missing "with", a removed target and drift', async () => {
    const world = makeWorld({ packFiles: { [REPLACEMENT_FILE]: 'x\n' } })
    expect((await run(world, replace(world, '$lib/components/nope.svelte'))).messages).toEqual([
      expect.stringContaining('does not exist in web-host'),
    ])
    const noWith = manifest({
      replacements: { [TARGET]: { with: './nope.svelte', hostSha256: sha(world, HOST_PATH) } },
    })
    expect((await run(world, noWith)).messages).toEqual([
      expect.stringContaining('./nope.svelte does not exist in the UI pack'),
    ])
    const removed = { ...replace(world), routes: { remove: [HOST_PATH] } }
    expect((await run(world, removed)).messages).toEqual([expect.stringContaining('both replaced')])
    const drifted = manifest({
      replacements: { [TARGET]: { with: REPLACEMENT_WITH, hostSha256: 'c'.repeat(64) } },
    })
    expect((await run(world, drifted)).messages[0]).toContain(`DRIFT ${TARGET} (replacement)`)
  })

  it('fails an ambiguous extension-less target naming both candidates', async () => {
    const world = makeWorld({
      hostFiles: { 'src/lib/dup.ts': 'a', 'src/lib/dup.js': 'b' },
      packFiles: { 'r/dup.ts': 'x' },
    })
    const result = await run(
      world,
      manifest({ replacements: { '$lib/dup': { with: './r/dup.ts', hostSha256: 'a'.repeat(64) } } })
    )
    expect(result.messages).toEqual([expect.stringContaining('src/lib/dup.ts, src/lib/dup.js')])
  })
})

describe('AC-8/AC-9: the lock, --check, drift and --accept-host', () => {
  it('is byte-identical across different roots', async () => {
    const worldA = makeWorld({ packFiles: { [DASHBOARD]: 'cm\n' } })
    const worldB = makeWorld({ packFiles: { [DASHBOARD]: 'cm\n' } })
    const a = dashboardOverride(worldA)
    const b = dashboardOverride(worldB)
    await run(worldA, a.pack)
    await run(worldB, b.pack)
    expect(read(worldA, LOCK_FILE)).toBe(read(worldB, LOCK_FILE))
    expect(read(worldA, LOCK_FILE)).not.toContain(worldA.root)
  })

  it('--check passes on an unchanged lock, ignores notes, and fails with a diff otherwise', async () => {
    const world = makeWorld({ packFiles: { [BILLING_PAGE]: 'b\n' } })
    expect((await run(world, manifest(), { check: true })).messages).toEqual([
      expect.stringContaining('no committed lock'),
    ])
    await run(world, manifest())
    expect((await run(world, manifest(), { check: true })).ok).toBe(true)
    writeAll(world.pack, { 'src/routes/other/+page.svelte': 'o\n' })
    const stale = await run(world, manifest(), { check: true })
    expect(stale.ok).toBe(false)
    expect(stale.messages[0]).toContain('run pv-compose and commit the lock')
    expect(stale.messages[0]).toContain('+      "path": "src/routes/other/+page.svelte"')
  })

  it('--check ignores a changed note and a removed file hash', async () => {
    const world = makeWorld()
    const pack = manifest({ routes: { remove: ['/login'] } })
    await run(world, pack)
    const lockPath = join(world.app, LOCK_FILE)
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      notes: string[]
      removals: { hostSha256: string }[]
    }
    lock.notes.push('an old note')
    const removal = lock.removals[0]
    if (removal) removal.hostSha256 = 'f'.repeat(64)
    writeFileSync(lockPath, JSON.stringify(lock))
    expect((await run(world, pack, { check: true })).ok).toBe(true)
  })

  it('fails a lock from a newer kit and a lock without lockfileVersion', async () => {
    const world = makeWorld()
    await run(world, manifest())
    const lockPath = join(world.app, LOCK_FILE)
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
    writeFileSync(lockPath, JSON.stringify({ ...lock, lockfileVersion: 2 }))
    expect((await run(world, manifest(), { check: true })).messages).toEqual([
      expect.stringContaining('newer kit'),
    ])
    const { lockfileVersion: _dropped, ...rest } = lock
    writeFileSync(lockPath, JSON.stringify(rest))
    expect((await run(world, manifest(), { check: true })).messages).toEqual([
      expect.stringContaining('composition.lock.schema.json'),
    ])
  })

  it('--accept-host records the new hash in the lock, never the manifest, and the next run passes', async () => {
    const world = makeWorld({ packFiles: { [DASHBOARD]: 'cm\n' } })
    const { pack } = dashboardOverride(world)
    await run(world, pack)
    writeAll(world.host, { [DASHBOARD]: DASHBOARD_V2 })
    const drifted = await run(world, pack)
    expect(drifted.ok).toBe(false)
    expect(drifted.messages[0]).toContain('DRIFT')
    const accepted = await run(world, pack, { acceptHost: [DASHBOARD] })
    expect(accepted.ok).toBe(true)
    expect(accepted.messages).toEqual([
      `accepted ${DASHBOARD}: ${sha(world, DASHBOARD)} -> ${shaOf(DASHBOARD_V2)} (PV 1.5.0)`,
    ])
    expect((await run(world, pack)).ok).toBe(true)
    expect((await run(world, pack, { check: true })).ok).toBe(true)
    const again = await run(world, pack, { acceptHost: [DASHBOARD] })
    expect(again.messages).toEqual([`already accepted: ${DASHBOARD}`])
  })

  it('--accept-host refuses an undeclared path and leaves the lock untouched', async () => {
    const world = makeWorld()
    await run(world, manifest())
    const before = read(world, LOCK_FILE)
    const result = await run(world, manifest(), { acceptHost: [LOGIN_PAGE] })
    expect(result.ok).toBe(false)
    expect(result.messages[0]).toContain('not declared as an override or replacement')
    expect(read(world, LOCK_FILE)).toBe(before)
  })

  it('--accept-host keeps an acceptance in the lock even when another file still drifts', async () => {
    const world = makeWorld({ packFiles: { [DASHBOARD]: 'cm\n', [LOGIN_PAGE]: 'cm login\n' } })
    const pack = manifest({
      routes: {
        overrides: [
          { path: DASHBOARD, hostSha256: sha(world, DASHBOARD), story: 'a' },
          { path: LOGIN_PAGE, hostSha256: sha(world, LOGIN_PAGE), story: 'b' },
        ],
      },
    })
    await run(world, pack)
    writeAll(world.host, { [DASHBOARD]: 'v2\n', [LOGIN_PAGE]: 'v2\n' })
    const partial = await run(world, pack, { acceptHost: [DASHBOARD] })
    expect(partial.ok).toBe(false)
    expect(partial.messages.join('\n')).toContain('DRIFT src/routes/login/+page.svelte')
    expect(partial.messages.join('\n')).not.toContain(`DRIFT ${DASHBOARD}`)
    const final = await run(world, pack, { acceptHost: [LOGIN_PAGE] })
    expect(final.ok).toBe(true)
  })

  it('prints the true old-to-new PV diff with --previous-host', async () => {
    const world = makeWorld({ packFiles: { [DASHBOARD]: 'cm\n' } })
    const { pack } = dashboardOverride(world)
    const previous = join(world.root, 'previous')
    writeAll(previous, { [DASHBOARD]: hostBytes(DASHBOARD) as string })
    writeAll(world.host, { [DASHBOARD]: DASHBOARD_V2 })
    const result = await run(world, pack, { previousHost: previous })
    expect(result.messages[0]).toContain('previous web-host vs new web-host')
    expect(result.messages[0]).toContain('-<h1>Dashboard</h1>')
    expect(result.messages[0]).toContain('+<h1>Dashboard v2</h1>')
    const missing = await run(world, pack, { previousHost: join(world.root, 'empty') })
    expect(missing.messages[0]).toContain('does not contain this file')
  })

  it('reports every drifted file in one run, sorted by path, and binary files without bytes', async () => {
    const world = makeWorld({
      packFiles: { [FAVICON]: Buffer.from([9, 9, 0]), [DASHBOARD]: 'cm\n' },
    })
    const pack = manifest({
      routes: {
        overrides: [
          { path: DASHBOARD, hostSha256: '1'.repeat(64) },
          { path: FAVICON, hostSha256: '2'.repeat(64) },
        ],
      },
    })
    const result = await run(world, pack)
    expect(result.messages.map((m) => m.split('\n')[0])).toEqual([
      `DRIFT ${DASHBOARD} (override)`,
      'DRIFT static/favicon.png (override)',
    ])
    expect(result.messages[1]).toContain('Binary files')
  })
})

describe('AC-10: the compatibility tuple gates composing, before any copying', () => {
  it('fails on CM today (four mismatches) and leaves the previous tree intact', async () => {
    const world = makeWorld({
      appVersions: {
        '@sveltejs/kit': '2.70.2',
        svelte: '5.56.8',
        vite: '7.3.6',
        typescript: '5.9.3',
      },
    })
    writeAll(world.app, { 'src/previous.txt': 'x', 'src/.pv-compose-generated': 'x' })
    const result = await run(world, manifest(), { appLabel: 'apps/pv-composed' })
    expect(result.messages).toEqual([
      'Compatibility mismatch: @sveltejs/kit resolved 2.70.2 (apps/pv-composed), web-host was built with 2.70.3.',
      'Compatibility mismatch: svelte resolved 5.56.8 (apps/pv-composed), web-host was built with 5.57.1.',
      'Compatibility mismatch: typescript resolved 5.9.3 (apps/pv-composed), web-host was built with 6.0.3.',
      'Compatibility mismatch: vite resolved 7.3.6 (apps/pv-composed), web-host was built with 8.3.1.',
    ])
    expect(read(world, 'src/previous.txt')).toBe('x')
  })

  it('fails a manifest for another PV release and a missing runtime dependency', async () => {
    const world = makeWorld({ hostDependencies: { undici: '7.29.1' } })
    writeAll(world.app, { 'package.json': JSON.stringify({ dependencies: {} }) })
    const result = await run(world, { host: { pvRelease: '1.4.0' } })
    expect(result.messages).toEqual([
      expect.stringContaining('manifest targets PV 1.4.0 but web-host is 1.5.0'),
      expect.stringContaining('Runtime dependency undici must be a runtime dependency'),
    ])
  })

  it('has no way to skip the check', async () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8')
    expect(source).not.toMatch(/skip-compat|skipCompat|--force|--no-check/)
  })
})
