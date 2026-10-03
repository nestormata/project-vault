// Story 68.6 AC-1/AC-8/AC-11/AC-12 — the kit side of hooks, header policy and protected paths:
// route-id derivation, protectedPaths integrity and notes, hook export notes, the hooks-surface
// manifest, the generated virtual modules and the compose/lock wiring.
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as TypeScript from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import { deferredNotes } from '../src/contributions.js'
import {
  exportNames,
  hookExportNotes,
  overriddenHookNotes,
  readHooksSurface,
  type HooksSurface,
} from '../src/hooks-surface.js'
import { parseLock } from '../src/lock.js'
import { deriveProtectedRoutes, protectedPathsFindings } from '../src/protected-paths.js'
import { isRouteFile, routeIdOfFile, stripRouteGroups } from '../src/route-files.js'
import { hooksModuleCode, pvHooks, PV_HOOKS_PLUGIN_NAME } from '../src/vite/hooks.js'
import {
  RESOLVE_FROM,
  makeWorld,
  manifest,
  sha,
  useWorlds,
  writeAll,
  type World,
} from './compose-test-helpers.js'

useWorlds()

const ts = createRequire(import.meta.url)('typescript') as typeof TypeScript

const PV_PREFIXES = [
  '/dashboard',
  '/projects',
  '/credentials',
  '/alerts',
  '/health',
  '/settings',
  '/platform',
  '/notifications',
  '/extensions/panels',
]

const SURFACE: HooksSurface = {
  server: ['handle', 'handleError', 'handleFetch', 'handleValidationError', 'init'],
  universal: ['reroute', 'transport'],
  client: ['handleError', 'init'],
  protectedPrefixes: PV_PREFIXES,
}

const SURFACE_JSON = `${JSON.stringify({
  schemaVersion: 1,
  server: SURFACE.server,
  universal: SURFACE.universal,
  client: SURFACE.client,
  headerPolicy: true,
  protectedPaths: true,
  protectedPrefixes: PV_PREFIXES,
})}\n`

const CM_AREA_PAGE = 'src/routes/(app)/cm-area/+page.svelte'
const CM_AREA_ID = '/(app)/cm-area'
const CM_EXPORT_ID = '/(app)/cm-area/export'
const CM_CALLBACK_ID = '/(app)/cm-area/callback'
const PUBLIC_CM = '/public-cm'
const HOOKS_SERVER_FILE = 'src/hooks.server.ts'
const SERVER_MODULE_ID = '\0virtual:pv-hooks/server'

describe('route-files (the one route-id helper)', () => {
  it('maps route files to Kit route ids and ignores layouts and error pages', () => {
    expect(routeIdOfFile(CM_AREA_PAGE)).toBe(CM_AREA_ID)
    expect(routeIdOfFile('src/routes/(app)/cm-area/export/+server.ts')).toBe(CM_EXPORT_ID)
    expect(routeIdOfFile('src/routes/+page.svelte')).toBe('/')
    expect(routeIdOfFile('src/routes/(app)/+layout.server.ts')).toBeNull()
    expect(routeIdOfFile('src/routes/(app)/x/+error.svelte')).toBeNull()
    expect(routeIdOfFile('src/lib/x/+page.svelte')).toBeNull()
    expect(isRouteFile('src/routes/a/+page.server.js')).toBe(true)
  })

  it('a page that resets its layout (+page@.svelte, +page@(group).svelte) is a route file', () => {
    // Code review 68-6: such a page escapes (app)/+layout.server.ts, so the hook is its only gate.
    expect(routeIdOfFile('src/routes/(app)/cm-reset/+page@.svelte')).toBe('/(app)/cm-reset')
    expect(routeIdOfFile('src/routes/(app)/a/b/+page@(app).svelte')).toBe('/(app)/a/b')
    expect(routeIdOfFile('src/routes/(app)/a/[id]/+page@[id].svelte')).toBe('/(app)/a/[id]')
    expect(routeIdOfFile('src/routes/(app)/x/+layout@.svelte')).toBeNull()
    expect(routeIdOfFile('src/routes/(app)/x/+page@.server.ts')).toBeNull()
  })

  it('strips groups with a linear split (long input)', () => {
    expect(stripRouteGroups('/(app)/(nested)/reports/[id]')).toBe('/reports/[id]')
    expect(stripRouteGroups('/(app)')).toBe('/')
    expect(stripRouteGroups(`/${'(g)/'.repeat(50_000)}x`)).toBe('/x')
  })
})

describe('deriveProtectedRoutes (AC-8)', () => {
  it('derives each CM route under (app): additions and overrides, nested groups, dynamic params', () => {
    expect(
      deriveProtectedRoutes([
        CM_AREA_PAGE,
        'src/routes/(app)/cm-area/+page.server.ts',
        'src/routes/(app)/cm-area/export/+server.ts',
        'src/routes/(app)/(nested)/reports/[id]/+page.svelte',
        'src/routes/(app)/shares/[token]/+page.server.ts',
        'src/routes/billing/+page.svelte',
        'src/routes/(app)/only-layout/+layout.svelte',
        'src/routes/(app)/x/+error.svelte',
        'src/lib/_cm/thing.ts',
      ])
    ).toEqual([
      { routeId: '/(app)/(nested)/reports/[id]', urlPattern: '/reports/[id]' },
      { routeId: CM_AREA_ID, urlPattern: '/cm-area' },
      { routeId: CM_EXPORT_ID, urlPattern: '/cm-area/export' },
      { routeId: '/(app)/shares/[token]', urlPattern: '/shares/[token]' },
    ])
  })
})

function findings(
  protectedPaths: { add?: string[]; remove?: string[] } | undefined,
  files: string[] = []
) {
  return protectedPathsFindings({
    manifest: manifest(protectedPaths === undefined ? {} : { protectedPaths }),
    cmRouteFiles: files,
    pvPrefixes: PV_PREFIXES,
  })
}

describe('protectedPathsFindings (AC-8, Q8)', () => {
  it('fails on malformed add entries and on an entry in both lists, all in one run', () => {
    const result = findings({ add: ['x', '/a?b', '/c#d', '/e/', '/'], remove: ['/f'] })
    expect(result.problems).toEqual([
      'protectedPaths.add "/" must not end with "/"',
      'protectedPaths.add "/a?b" must not contain "?" or "#"',
      'protectedPaths.add "/c#d" must not contain "?" or "#"',
      'protectedPaths.add "/e/" must not end with "/"',
      'protectedPaths.add "x" must start with "/"',
    ])
    expect(findings({ add: ['/f'], remove: ['/f'] }).problems).toEqual([
      '"/f" is in both protectedPaths.add and protectedPaths.remove',
    ])
  })

  it('fails when a prefix or derived route covers a guard redirect target (redirect loop)', () => {
    expect(findings({ add: ['/login'] }).problems).toEqual([
      'protectedPaths: prefix "/login" covers the guard redirect target /login (redirect loop)',
    ])
    expect(findings(undefined, ['src/routes/(app)/vault/+page.svelte']).problems).toEqual([
      'protectedPaths: derived route "/(app)/vault" covers the guard redirect target /vault (redirect loop)',
    ])
  })

  it('records remove semantics with notes, never failing (anti-allowlist)', () => {
    const result = findings({ remove: [...PV_PREFIXES, '/x', CM_CALLBACK_ID] }, [
      CM_AREA_PAGE,
      'src/routes/(app)/cm-area/callback/+server.ts',
    ])
    expect(result.problems).toEqual([])
    expect(result.notes).toContain(
      'protectedPaths.remove "/x" matches no protected prefix or derived route'
    )
    expect(result.notes).toContain(
      'PV prefix /health is no longer protected by the hook; (app)/+layout.server.ts still redirects page loads, but actions and +server under it are now ungated'
    )
    expect(result.record.derived.map((route) => route.routeId)).toEqual([
      CM_AREA_ID,
      CM_CALLBACK_ID,
    ])
    expect(result.record.remove).toContain(CM_CALLBACK_ID)
  })

  it('de-duplicates add with a note and lists public CM routes', () => {
    const result = findings({ add: [PUBLIC_CM, PUBLIC_CM] }, [
      'src/routes/billing/+page.svelte',
      'src/routes/public-cm/+page.svelte',
      'src/routes/(cm)/billing/+page.svelte',
      CM_AREA_PAGE,
    ])
    expect(result.record.add).toEqual([PUBLIC_CM])
    expect(result.notes).toEqual([
      'CM route /(cm)/billing is public: not under (app) and not in protectedPaths.add',
      'CM route /billing is public: not under (app) and not in protectedPaths.add',
      'protectedPaths.add "/public-cm" is listed twice; de-duplicated',
    ])
    expect(result.summary).toBe(
      'protected paths: 1 derived (app) routes, 1 added, 0 removed (3 notes)'
    )
  })
})

describe('hook export notes (Q11, AC-12)', () => {
  it('reads export names with TypeScript (values only, not types)', () => {
    const source = [
      'export const handle = 1',
      'export function init() {}',
      'export class Thing {}',
      'const a = 1, b = 2',
      'export { a, b as handleFetch }',
      'export type T = string',
      'export interface I {}',
      "export * from './x'",
    ].join('\n')
    expect(exportNames(source, ts, 'x.ts')).toEqual(['handle', 'init', 'Thing', 'a', 'handleFetch'])
  })

  it('notes non-hook names, near misses and hooks of another file; headerPolicy is a server export', () => {
    expect(
      hookExportNotes(
        'server',
        ['handle', 'headerPolicy', 'hookLabel', 'handel', 'reroute'],
        SURFACE
      )
    ).toEqual([
      'hooks.server: export `hookLabel` is not a SvelteKit server hook; not composed',
      'hooks.server: export `handel` is not a SvelteKit server hook; not composed; did you mean `handle`?',
      'hooks.server: `reroute` is a universal hook; move it to hooks.universal',
    ])
    expect(hookExportNotes('client', ['init', 'headerPolicy'], SURFACE)).toEqual([
      'hooks.client: export `headerPolicy` is not a SvelteKit client hook; not composed',
    ])
  })

  it('a full override of a hooks file wins; the contribution is noted, not failed (AC-11)', () => {
    expect(
      overriddenHookNotes({ server: './h.ts', client: './c.ts' }, new Set([HOOKS_SERVER_FILE]))
    ).toEqual([
      'hooks.server contribution is not composed because src/hooks.server.ts is overridden; import it from your override if you want it',
    ])
  })
})

describe('readHooksSurface (AC-12)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const host = (content?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'hooks-surface-'))
    dirs.push(dir)
    if (content !== undefined) writeAll(dir, { 'manifests/hooks-surface.json': content })
    return dir
  }

  it('an older web-host without the file: no surface, no problem', () => {
    expect(readHooksSurface(host())).toEqual({ problems: [] })
  })

  it('reads a valid file and reports a malformed one', () => {
    expect(readHooksSurface(host(SURFACE_JSON)).surface).toEqual(SURFACE)
    expect(readHooksSurface(host('{"schemaVersion":2}')).problems).toEqual([
      'manifests/hooks-surface.json: expected { schemaVersion: 1, server, universal, client, protectedPrefixes }',
    ])
  })
})

describe('generated virtual modules (AC-1)', () => {
  it('empty modules without contributions; server carries empty protected paths', () => {
    expect(hooksModuleCode('client', undefined, '/app')).toBe(
      'export const hooks = Object.freeze({})\n'
    )
    expect(hooksModuleCode('server', undefined, '/app')).toContain(
      'export const protectedPaths = Object.freeze({"routeIds":[],"add":[],"remove":[]})'
    )
  })

  it('re-exports the materialized file namespace and the derived data', () => {
    const code = hooksModuleCode(
      'server',
      {
        hooks: { server: 'src/lib/server/_cm/hooks.server.ts' },
        nav: null,
        theme: null,
        protectedPaths: {
          add: [PUBLIC_CM],
          remove: [],
          derived: [{ routeId: CM_AREA_ID, urlPattern: '/cm-area' }],
        },
      },
      '/app'
    )
    expect(code).toContain('export * as hooks from "$lib/server/_cm/hooks.server.ts"')
    expect(code).toContain('"routeIds":["/(app)/cm-area"]')
    expect(code).toContain('"add":["/public-cm"]')
  })

  it('emits every path with JSON.stringify (quotes, backticks, ${, backslash, newline round-trip)', async () => {
    const nasty = 'src/x/"q`${b}\\n\nl.ts'
    const code = hooksModuleCode(
      'universal',
      { hooks: { universal: nasty }, nav: null, theme: null, protectedPaths: null },
      '/app'
    )
    const specifier = /from (".*")\n/s.exec(code)?.[1] ?? ''
    expect(JSON.parse(specifier)).toBe(join('/app', nasty))
  })

  it('pvHooks resolves the three ids with \\0 prefixes, pre-ordered, named for web-host', () => {
    const plugin = pvHooks({ appRoot: '/nonexistent-app' })
    expect(plugin.name).toBe(PV_HOOKS_PLUGIN_NAME)
    expect(plugin.enforce).toBe('pre')
    const resolveId = plugin.resolveId as (id: string) => string | null
    const load = plugin.load as (id: string) => string | null
    expect(resolveId('virtual:pv-hooks/server')).toBe(SERVER_MODULE_ID)
    expect(resolveId('virtual:pv-hooks/nope')).toBeNull()
    expect(resolveId('other')).toBeNull()
    expect(load('\0other')).toBeNull()
  })

  it('a missing lock fails closed with a clear message (code review 68-6), in load only', () => {
    const plugin = pvHooks({ appRoot: '/nonexistent-app' })
    const load = plugin.load as (id: string) => string | null
    for (const kind of ['server', 'universal', 'client']) {
      expect(() => load(`\0virtual:pv-hooks/${kind}`)).toThrow(
        'pvHooks(): no composition.lock.json at /nonexistent-app/composition.lock.json'
      )
    }
    // The dev server may start before pvComposeDev writes the first lock: no throw there.
    expect(() =>
      (plugin.configureServer as (server: unknown) => void)({
        watcher: { add: () => undefined, on: () => undefined },
        restart: async () => undefined,
      })
    ).not.toThrow()
  })
})

const HOOK_FILE = 'hooks.server.ts'
const ROUTES = {
  [CM_AREA_PAGE]: '<h1>cm</h1>\n',
  'src/routes/(app)/cm-area/+page.server.ts': 'export const actions = { save: () => ({}) }\n',
  'src/routes/(app)/cm-area/export/+server.ts': 'export const GET = () => new Response()\n',
  'src/routes/billing/+page.svelte': '<h1>billing</h1>\n',
}

async function run(world: World, pack: unknown) {
  return compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: pack,
    resolveFrom: RESOLVE_FROM,
  })
}

describe('compose with a web-host that ships hooks-surface.json (AC-8, AC-12)', () => {
  it('applies: no deferred notes, derived routes in the lock, export notes', async () => {
    const world = makeWorld({
      hostFiles: { 'manifests/hooks-surface.json': SURFACE_JSON },
      packFiles: {
        ...ROUTES,
        [HOOK_FILE]:
          "export const hookLabel = 'mini'\nexport const handle = ({ event, resolve }) => resolve(event)\n",
      },
    })
    const result = await run(
      world,
      manifest({ hooks: { server: `./${HOOK_FILE}` }, protectedPaths: { add: [PUBLIC_CM] } })
    )
    expect(result.messages).toEqual([])
    expect(result.plan.notes).not.toContainEqual(expect.stringContaining('not applied'))
    expect(result.plan.notes).toContain(
      'hooks.server: export `hookLabel` is not a SvelteKit server hook; not composed'
    )
    expect(result.plan.notes).toContain(
      'CM route /billing is public: not under (app) and not in protectedPaths.add'
    )
    const lock = JSON.parse(result.plan.lockText ?? '{}')
    expect(lock.contributions.protectedPaths).toEqual({
      add: [PUBLIC_CM],
      remove: [],
      derived: [
        { routeId: CM_AREA_ID, urlPattern: '/cm-area' },
        { routeId: CM_EXPORT_ID, urlPattern: '/cm-area/export' },
      ],
    })
  })

  it('records derived routes even without a protectedPaths field', async () => {
    const world = makeWorld({
      hostFiles: { 'manifests/hooks-surface.json': SURFACE_JSON },
      packFiles: ROUTES,
    })
    const result = await run(world, manifest())
    expect(result.plan.lock?.contributions.protectedPaths?.derived).toHaveLength(2)
  })

  it('fails on an integrity problem (redirect loop) with exit-1 semantics', async () => {
    const world = makeWorld({ hostFiles: { 'manifests/hooks-surface.json': SURFACE_JSON } })
    const result = await run(world, manifest({ protectedPaths: { add: ['/register'] } }))
    expect(result.ok).toBe(false)
    expect(result.messages).toContain(
      'protectedPaths: prefix "/register" covers the guard redirect target /register (redirect loop)'
    )
  })

  it('a full override of hooks.server.ts plus a hooks.server contribution is a note (AC-11)', async () => {
    const world = makeWorld({
      hostFiles: { 'manifests/hooks-surface.json': SURFACE_JSON },
      packFiles: {
        [HOOKS_SERVER_FILE]: 'export const handle = ({ event, resolve }) => resolve(event)\n',
        [HOOK_FILE]: 'export const init = () => {}\n',
      },
    })
    const result = await run(
      world,
      manifest({
        routes: {
          overrides: [{ path: HOOKS_SERVER_FILE, hostSha256: sha(world, HOOKS_SERVER_FILE) }],
        },
        hooks: { server: `./${HOOK_FILE}` },
      })
    )
    expect(result.ok).toBe(true)
    expect(result.plan.notes).toContain(
      'hooks.server contribution is not composed because src/hooks.server.ts is overridden; import it from your override if you want it'
    )
  })
})

describe('compose with an older web-host (no hooks-surface.json): 68-3 behaviour', () => {
  it('keeps the not-applied notes and records derived: []', async () => {
    const world = makeWorld({ packFiles: { ...ROUTES, [HOOK_FILE]: 'export const handle = 1\n' } })
    const result = await run(
      world,
      manifest({ hooks: { server: `./${HOOK_FILE}` }, protectedPaths: { add: ['/x'] } })
    )
    expect(result.plan.notes).toContainEqual(
      expect.stringContaining('hook composition not applied')
    )
    expect(result.plan.notes).toContainEqual(expect.stringContaining('protectedPaths not applied'))
    expect(result.plan.lock?.contributions.protectedPaths).toEqual({
      add: ['/x'],
      remove: [],
      derived: [],
    })
  })

  it('deferredNotes is empty for a supporting host', () => {
    expect(
      deferredNotes(manifest({ hooks: { server: './h.ts' }, protectedPaths: {} }), true)
    ).toEqual([])
  })
})

describe('lock compatibility (AC-8)', () => {
  it('reads a pre-68.6 lock without derived as derived: []', () => {
    const lock = {
      lockfileVersion: 1,
      compatibility: {},
      overrides: [],
      additions: [],
      removals: [],
      replacements: [],
      materialized: [],
      contributions: {
        hooks: {},
        nav: null,
        theme: null,
        protectedPaths: { add: ['/a'], remove: [] },
      },
      injectionPointsUsed: [],
      navIdsReferenced: [],
      apiRouteOverrides: [],
      notes: [],
    }
    expect(parseLock(JSON.stringify(lock), 'lock').lock?.contributions.protectedPaths).toEqual({
      add: ['/a'],
      remove: [],
      derived: [],
    })
  })
})

describe('pvHooks() against a composed app (AC-1 dev edge)', () => {
  it('loads from the lock, follows Vite root, and restarts dev only when the contribution changes', async () => {
    const world = makeWorld({
      hostFiles: { 'manifests/hooks-surface.json': SURFACE_JSON },
      packFiles: { [CM_AREA_PAGE]: 'cm\n', [HOOK_FILE]: 'export const init = () => {}\n' },
    })
    expect((await run(world, manifest({ hooks: { server: `./${HOOK_FILE}` } }))).ok).toBe(true)
    const plugin = pvHooks()
    ;(plugin.configResolved as (config: { root: string }) => void)({ root: world.app })
    const load = plugin.load as (id: string) => string | null
    expect(load(SERVER_MODULE_ID)).toContain(
      'export * as hooks from "$lib/server/_cm/hooks.server.ts"'
    )
    expect(load(SERVER_MODULE_ID)).toContain(`"routeIds":["${CM_AREA_ID}"]`)

    const relative = pvHooks({ appRoot: 'app' })
    ;(relative.configResolved as (config: { root: string }) => void)({ root: world.root })
    expect((relative.load as (id: string) => string | null)(SERVER_MODULE_ID)).toContain(CM_AREA_ID)

    let onChange: (path: string) => void = () => undefined
    let restarts = 0
    ;(plugin.configureServer as (server: unknown) => void)({
      watcher: {
        add: () => undefined,
        on: (_event: string, cb: (path: string) => void) => (onChange = cb),
      },
      restart: async () => {
        restarts++
      },
    })
    const lockPath = join(world.app, 'composition.lock.json')
    onChange(join(world.app, 'other.ts'))
    onChange(lockPath)
    expect(restarts).toBe(0)
    expect(
      (
        await run(
          world,
          manifest({ hooks: { server: `./${HOOK_FILE}` }, protectedPaths: { add: [PUBLIC_CM] } })
        )
      ).ok
    ).toBe(true)
    onChange(lockPath)
    expect(restarts).toBe(1)
  })

  it('a corrupt lock is a loud error, not empty hooks', () => {
    const world = makeWorld()
    writeAll(world.app, { 'composition.lock.json': '{not json' })
    const plugin = pvHooks({ appRoot: world.app })
    expect(() =>
      (plugin.load as (id: string) => string | null)('\0virtual:pv-hooks/client')
    ).toThrow('pvHooks(): ')
  })
})
