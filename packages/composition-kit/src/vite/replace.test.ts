// Story 68.5 AC-1, AC-3, AC-5, AC-6, AC-7, AC-15: `pvReplace` shadows a module by its RESOLVED
// absolute path. Resolution and bundle assertions use a real Vite `build` over a tiny app; the
// edge cases that need a hand-made resolver context call the hook directly.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, createServer, type Plugin } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DevServerLike } from './dev-server.js'
import { pvReplace } from './replace.js'

const UTIL_SPEC = '$lib/util.ts'
const HOST_UTIL = 'src/lib/util.ts'
const CM_UTIL_FILE = 'src/lib/_cm/util.ts'
const MAIN_ENTRY = 'src/main.ts'
const MAP_FILE = '.pv-compose/replacements.json'
const IMPORT_UTIL = "import { name } from '$lib/util.ts'\nexport const all = name\n"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const UTIL_MAP = [{ target: UTIL_SPEC, host: HOST_UTIL, with: CM_UTIL_FILE }]

const BASE_FILES: Record<string, string> = {
  'package.json': '{"name":"app"}',
  [HOST_UTIL]: "export const name = 'PV_UTIL'\n",
  [CM_UTIL_FILE]: "export const name = 'CM_UTIL'\n",
  'src/lib/util2.ts': "export const name = 'PV_UTIL2'\n",
  'src/lib/utilx.ts': "export const name = 'PV_UTILX'\n",
  'src/lib/other/util.ts': "export const name = 'PV_OTHER_UTIL'\n",
  'src/lib/util.ts.bak': 'PV_BAK\n',
}

function mapJson(replacements: unknown[], schemaVersion = 1): string {
  return `${JSON.stringify({ schemaVersion, replacements }, null, 2)}\n`
}

function makeApp(
  files: Record<string, string> = {},
  map: string | null = mapJson(UTIL_MAP)
): string {
  const root = mkdtempSync(join(tmpdir(), 'pv-replace-'))
  roots.push(root)
  const all = new Map<string, string>(Object.entries({ ...BASE_FILES, ...files }))
  if (map !== null) all.set(MAP_FILE, map)
  for (const [rel, content] of all) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

async function bundle(
  root: string,
  entry: string,
  options: { ssr?: boolean; plugins?: Plugin[]; appRoot?: string } = {}
): Promise<string> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: [{ find: /^\$lib\//, replacement: `${root}/src/lib/` }] },
    plugins: options.plugins ?? [pvReplace({ appRoot: options.appRoot ?? root })],
    build: {
      write: false,
      minify: false,
      ...(options.ssr === true
        ? { ssr: entry }
        : { lib: { entry, formats: ['es'], fileName: 'out' } }),
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]) as {
    output: { type: string; code?: string }[]
  }[]
  return outputs
    .flatMap((one) => one.output)
    .map((chunk) => chunk.code ?? '')
    .join('\n')
}

type Hook = (this: unknown, ...args: unknown[]) => unknown

function call(
  plugin: Plugin,
  name: 'resolveId' | 'buildStart',
  context: unknown,
  ...args: unknown[]
) {
  const hook = Reflect.get(plugin, name) as Hook
  return hook.apply(context, args)
}

interface FakeContext {
  resolve: ReturnType<typeof vi.fn>
  error: (message: string) => never
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
}

function context(resolved: Record<string, string | null> = {}): FakeContext {
  return {
    resolve: vi.fn(async (source: string) => {
      const id = Reflect.get(resolved, source) as string | null | undefined
      // A dev server leaves `external` out; a build sets it to false (a real dev-only bug once).
      return id === undefined || id === null ? null : { id }
    }),
    error(message: string): never {
      throw new Error(message)
    },
    info: vi.fn(),
    warn: vi.fn(),
  }
}

describe('AC-1: shadowing by resolved absolute path, in the client and in SSR', () => {
  const entry = MAIN_ENTRY
  const MAIN = [
    "import { name as a } from '$lib/util.ts'",
    "import { name as b } from '$lib/util'",
    "import { name as c } from './lib/util.ts'",
    "import { name as d } from './lib/other/../util.ts'",
    'export const all = [a, b, c, d]',
  ].join('\n')

  it.each([
    ['client', false],
    ['ssr', true],
  ])('every spelling of the replaced file loads CM, and PV is gone (%s)', async (_name, ssr) => {
    const root = makeApp({ [entry]: `${MAIN}\n` })
    const code = await bundle(root, entry, { ssr })
    expect(code).toContain('CM_UTIL')
    expect(code).not.toContain('PV_UTIL')
  })

  it('replaces a server-folder module and a module whose importer sits inside $cm', async () => {
    const root = makeApp(
      {
        'src/lib/server/auth.ts': "export const who = 'PV_AUTH'\n",
        'src/lib/server/_cm/auth.ts': "export const who = 'CM_AUTH'\n",
        'src/lib/_cm/uses-util.ts': "import { name } from '$lib/util.ts'\nexport const n = name\n",
        [entry]:
          "import { who } from '$lib/server/auth.ts'\nimport { n } from '$lib/_cm/uses-util.ts'\nexport const all = [who, n]\n",
      },
      mapJson([
        ...UTIL_MAP,
        {
          target: '$lib/server/auth.ts',
          host: 'src/lib/server/auth.ts',
          with: 'src/lib/server/_cm/auth.ts',
        },
      ])
    )
    const code = await bundle(root, entry, { ssr: true })
    expect(code).toContain('CM_AUTH')
    expect(code).not.toContain('PV_AUTH')
    // Q8: a CM file that imports the replaced target by its normal specifier gets the replacement.
    expect(code).toContain('CM_UTIL')
  })

  it('does not replace a sibling, a same-basename file elsewhere, or a path that merely starts with the replaced one', async () => {
    const root = makeApp({
      [entry]: [
        "import { name as a } from '$lib/util2.ts'",
        "import { name as b } from '$lib/utilx.ts'",
        "import { name as c } from '$lib/other/util.ts'",
        "import bak from '$lib/util.ts.bak?raw'",
        'export const all = [a, b, c, bak]',
      ].join('\n'),
    })
    const code = await bundle(root, entry)
    for (const marker of ['PV_UTIL2', 'PV_UTILX', 'PV_OTHER_UTIL', 'PV_BAK']) {
      expect(code).toContain(marker)
    }
    expect(code).not.toContain('CM_UTIL')
  })

  it('keeps the query: ?raw of a replaced file yields CM source', async () => {
    const root = makeApp({
      [entry]: "import raw from '$lib/util.ts?raw'\nexport const all = raw\n",
    })
    const code = await bundle(root, entry)
    expect(code).toContain('CM_UTIL')
    expect(code).not.toContain('PV_UTIL')
  })

  it('compares real paths: a symlinked app root still matches', async () => {
    const root = makeApp({ [entry]: IMPORT_UTIL })
    const link = `${root}-link`
    symlinkSync(root, link)
    roots.push(link)
    const code = await bundle(root, entry, { appRoot: link })
    expect(code).toContain('CM_UTIL')
    expect(code).not.toContain('PV_UTIL')
  })

  it('is correct for a bare $lib source and for an absolute one (resolver order)', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, HOST_UTIL)
    const ctx = context({ [UTIL_SPEC]: abs, [abs]: abs })
    await call(plugin, 'buildStart', ctx)
    for (const source of [UTIL_SPEC, abs]) {
      expect(await call(plugin, 'resolveId', ctx, source, join(root, MAIN_ENTRY), {})).toEqual(
        expect.objectContaining({ id: join(root, CM_UTIL_FILE) })
      )
    }
  })

  it('resolves an entry with no importer, and passes through when nothing resolves', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, HOST_UTIL)
    const ctx = context({ [abs]: abs, missing: null })
    await call(plugin, 'buildStart', ctx)
    expect(await call(plugin, 'resolveId', ctx, abs, undefined, {})).toEqual(
      expect.objectContaining({ id: join(root, CM_UTIL_FILE) })
    )
    expect(await call(plugin, 'resolveId', ctx, 'missing', undefined, {})).toBeNull()
  })

  it('leaves an external id alone, and a nested bypass resolve untouched', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, HOST_UTIL)
    const ctx = context()
    ctx.resolve.mockResolvedValueOnce({ id: abs, external: true })
    await call(plugin, 'buildStart', ctx)
    expect(await call(plugin, 'resolveId', ctx, abs, undefined, {})).toBeNull()
    const bypass = { custom: { 'pv-replace': { bypass: true } } }
    expect(await call(plugin, 'resolveId', ctx, abs, undefined, bypass)).toBeNull()
    expect(ctx.resolve).toHaveBeenCalledTimes(1)
  })

  it('passes a non-replaced file through (null) with a single resolve call per import', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, 'src/lib/util2.ts')
    const ctx = context({ [abs]: abs })
    await call(plugin, 'buildStart', ctx)
    expect(await call(plugin, 'resolveId', ctx, abs, undefined, {})).toBeNull()
    expect(ctx.resolve).toHaveBeenCalledTimes(1)
    expect(ctx.resolve.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ skipSelf: true }))
  })

  it("works without Vite environments (vitest's vite-node has none)", async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const ctx = context()
    expect('environment' in ctx).toBe(false)
    expect(() => call(plugin, 'buildStart', ctx)).not.toThrow()
  })
})

describe('AC-16: a consumer that forgets the plugin gets PV, not the replacement', () => {
  it("imports PV's own file when pvReplace() is not among the plugins (why vitest needs it too)", async () => {
    const root = makeApp({ [MAIN_ENTRY]: IMPORT_UTIL })
    const code = await bundle(root, MAIN_ENTRY, { plugins: [] })
    expect(code).toContain('PV_UTIL')
    expect(code).not.toContain('CM_UTIL')
  })
})

describe('AC-5: id normalisation', () => {
  it('ignores virtual ids without resolving them', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const ctx = context()
    await call(plugin, 'buildStart', ctx)
    for (const source of ['\0virtual:x', 'virtual:pv-inject/a']) {
      expect(await call(plugin, 'resolveId', ctx, source, undefined, {})).toBeNull()
    }
    expect(ctx.resolve).not.toHaveBeenCalled()
  })

  it("never redirects a Svelte sub-request of PV's original file to CM's file", async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, HOST_UTIL)
    const style = `${abs}?svelte&type=style&lang.css`
    const ctx = context({ [style]: style })
    await call(plugin, 'buildStart', ctx)
    expect(await call(plugin, 'resolveId', ctx, style, abs, {})).toBeNull()
  })

  it('maps the file but keeps a non-svelte query and hash on the returned id', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, HOST_UTIL)
    const ctx = context({ [`${abs}?url`]: `${abs}?url`, [`${abs}#frag`]: `${abs}#frag` })
    await call(plugin, 'buildStart', ctx)
    expect(await call(plugin, 'resolveId', ctx, `${abs}?url`, undefined, {})).toEqual(
      expect.objectContaining({ id: `${join(root, CM_UTIL_FILE)}?url` })
    )
    expect(await call(plugin, 'resolveId', ctx, `${abs}#frag`, undefined, {})).toEqual(
      expect.objectContaining({ id: `${join(root, CM_UTIL_FILE)}#frag` })
    )
  })

  it('treats Windows separators as slashes but never matches by case', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const abs = join(root, HOST_UTIL)
    const upper = join(root, 'src/lib/UTIL.ts')
    const ctx = context({ back: abs.replaceAll('/', '\\'), upper })
    await call(plugin, 'buildStart', ctx)
    expect(await call(plugin, 'resolveId', ctx, 'back', undefined, {})).toEqual(
      expect.objectContaining({ id: join(root, CM_UTIL_FILE) })
    )
    expect(await call(plugin, 'resolveId', ctx, 'upper', undefined, {})).toBeNull()
  })
})

// SvelteKit's own `vite-plugin-sveltekit-guard` is an `enforce: 'pre'` plugin whose `resolveId`
// resolves every import itself (`this.resolve(..., { skipSelf: true })`) to record who imports what,
// and returns nothing. This stand-in does the same, so the order tests below fail for the reason the
// real consumer build does.
function guardLike(seen: Map<string, string[]>): Plugin {
  return {
    name: 'guard-like',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved !== null) seen.set(resolved.id, [...(seen.get(resolved.id) ?? []), importer])
      return null
    },
  }
}

describe('plugin order next to a resolving pre plugin (SvelteKit guard)', () => {
  const WRAP_FILES = {
    [CM_UTIL_FILE]:
      "import { name as original } from 'pv-original:$lib/util.ts'\nexport const name = `CM(${original})`\n",
    [MAIN_ENTRY]: IMPORT_UTIL,
  }

  it('listed AFTER it: a pv-original: wrap still reaches PV, and the guard sees the replacement', async () => {
    const root = makeApp(WRAP_FILES)
    const seen = new Map<string, string[]>()
    const code = await bundle(root, MAIN_ENTRY, {
      plugins: [guardLike(seen), pvReplace({ appRoot: root })],
    })
    expect(code).toContain('PV_UTIL')
    expect(code).toContain('CM(')
    expect(seen.get(join(root, CM_UTIL_FILE))).toEqual([join(root, MAIN_ENTRY)])
  })

  it('listed AFTER it: `export * from "pv-original:..."` re-exports PV\'s module', async () => {
    const root = makeApp({
      [CM_UTIL_FILE]: "export * from 'pv-original:$lib/util.ts'\nexport const extra = 'CM_EXTRA'\n",
      [MAIN_ENTRY]:
        "import { name, extra } from '$lib/util.ts'\nexport const all = [name, extra]\n",
    })
    const code = await bundle(root, MAIN_ENTRY, {
      plugins: [guardLike(new Map()), pvReplace({ appRoot: root })],
    })
    expect(code).toContain('PV_UTIL')
    expect(code).toContain('CM_EXTRA')
  })

  it('listed BEFORE it: the guard never sees the edge to the replacement', async () => {
    const root = makeApp(WRAP_FILES)
    const seen = new Map<string, string[]>()
    const code = await bundle(root, MAIN_ENTRY, {
      plugins: [pvReplace({ appRoot: root }), guardLike(seen)],
    })
    // The build still works; what is lost is the guard's import graph, which is why the guard fails
    // a client import of a replaced server module with "An impossible situation occurred".
    expect(code).toContain('PV_UTIL')
    expect(seen.get(join(root, CM_UTIL_FILE))).toBeUndefined()
  })
})

describe('AC-3: pv-original:', () => {
  const entry = MAIN_ENTRY

  it.each([
    ['client', false],
    ['ssr', true],
  ])("a replacement can wrap PV's original module (%s)", async (_name, ssr) => {
    const root = makeApp({
      [CM_UTIL_FILE]:
        "import { name as original } from 'pv-original:$lib/util.ts'\nexport const name = `CM(${original})`\n",
      [entry]: IMPORT_UTIL,
    })
    const code = await bundle(root, entry, { ssr })
    expect(code).toContain('CM(')
    expect(code).toContain('PV_UTIL')
  })

  it('resolves the original of a file nothing replaced to that file (identity, Q7)', async () => {
    const root = makeApp({
      [entry]: "import { name } from 'pv-original:$lib/util2.ts'\nexport const all = name\n",
    })
    expect(await bundle(root, entry)).toContain('PV_UTIL2')
  })

  it('accepts a relative remainder resolved against the importer', async () => {
    const root = makeApp({
      [CM_UTIL_FILE]:
        "import { name } from 'pv-original:../util.ts'\nexport { name as pv }\nexport const name2 = name\n",
      [entry]: "import { pv } from '$lib/util.ts'\nexport const all = pv\n",
    })
    expect(await bundle(root, entry)).toContain('PV_UTIL')
  })

  it('keeps a ?raw query on the original', async () => {
    const root = makeApp({
      [entry]: "import raw from 'pv-original:$lib/util.ts?raw'\nexport const all = raw\n",
    })
    const code = await bundle(root, entry)
    expect(code).toContain('PV_UTIL')
    expect(code).not.toContain('CM_UTIL')
  })

  it('resolves the original of a file a replaced import chain still uses (one decision per import)', async () => {
    const root = makeApp({
      [CM_UTIL_FILE]:
        "import { name as o } from 'pv-original:$lib/util.ts'\nexport const name = 'CM+' + o\n",
      'src/lib/pv-user.ts': "import { name } from '$lib/util.ts'\nexport const seen = name\n",
      [entry]: "import { seen } from '$lib/pv-user.ts'\nexport const all = seen\n",
    })
    const code = await bundle(root, entry)
    expect(code).toContain('CM+')
  })

  it('fails with a message naming the specifier for an empty or unresolvable remainder', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const ctx = context({})
    await call(plugin, 'buildStart', ctx)
    const importer = join(root, CM_UTIL_FILE)
    await expect(call(plugin, 'resolveId', ctx, 'pv-original:', importer, {})).rejects.toThrow(
      `pv-replace: cannot resolve "pv-original:" from ${importer}`
    )
    await expect(
      call(plugin, 'resolveId', ctx, 'pv-original:$lib/nope.ts', importer, {})
    ).rejects.toThrow(`pv-replace: cannot resolve "pv-original:$lib/nope.ts" from ${importer}`)
  })

  it('refuses a remainder that resolves outside <appRoot>/src (path containment)', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const outside = join(root, '..', 'etc-hostname')
    const ctx = context({ '../../../etc/hostname': outside })
    await call(plugin, 'buildStart', ctx)
    await expect(
      call(
        plugin,
        'resolveId',
        ctx,
        'pv-original:../../../etc/hostname',
        join(root, 'src/x.ts'),
        {}
      )
    ).rejects.toThrow('resolves outside')
  })
})

describe('AC-2 / AC-6 / AC-15: the map is read and checked at buildStart', () => {
  async function start(root: string, options: { lockPath?: string } = {}) {
    const ctx = context()
    await call(pvReplace({ appRoot: root, ...options }), 'buildStart', ctx)
    return ctx
  }

  it('logs one line per build and never console output', async () => {
    const root = makeApp()
    const plugin = pvReplace({ appRoot: root })
    const ctx = context()
    await call(plugin, 'buildStart', ctx)
    await call(plugin, 'buildStart', ctx)
    expect(ctx.info).toHaveBeenCalledTimes(1)
    expect(ctx.info).toHaveBeenCalledWith('pv-replace: 1 replacements applied')
  })

  it('fails when the map is absent (a skipped compose must not serve PV originals)', async () => {
    const root = makeApp({}, null)
    await expect(start(root)).rejects.toThrow('run pv-compose')
  })

  it('treats an empty map as no replacements', async () => {
    const root = makeApp({}, mapJson([]))
    const ctx = await start(root)
    expect(ctx.info).toHaveBeenCalledWith('pv-replace: 0 replacements applied')
  })

  it('fails for a schemaVersion it does not understand, naming the one it does', async () => {
    const root = makeApp({}, mapJson(UTIL_MAP, 2))
    await expect(start(root)).rejects.toThrow('schemaVersion 2')
    await expect(start(root)).rejects.toThrow('understands 1')
  })

  it('fails for invalid JSON without echoing content', async () => {
    const root = makeApp({}, 'not json SECRET_VALUE')
    const error = await start(root).catch((caught: Error) => caught)
    expect((error as Error).message).toContain('not valid JSON')
    expect((error as Error).message).not.toContain('SECRET_VALUE')
  })

  it.each([
    ['../../etc/passwd', CM_UTIL_FILE],
    ['/etc/passwd', CM_UTIL_FILE],
    [HOST_UTIL, '../outside.ts'],
    [HOST_UTIL, 'package.json'],
    ['src\\lib\\util.ts', CM_UTIL_FILE],
  ])('fails before reading anything for host %s with %s', async (host, withPath) => {
    const root = makeApp({}, mapJson([{ target: UTIL_SPEC, host, with: withPath }]))
    await expect(start(root)).rejects.toThrow(/pv-replace: map entry/)
  })

  it('fails when a with file is missing, naming both paths', async () => {
    const root = makeApp(
      {},
      mapJson([{ target: UTIL_SPEC, host: HOST_UTIL, with: 'src/lib/_cm/gone.ts' }])
    )
    await expect(start(root)).rejects.toThrow(
      'pv-replace: replacement for src/lib/util.ts points at missing src/lib/_cm/gone.ts; run pv-compose.'
    )
  })

  it('fails when the map names an entry the lock does not (hand-edited map)', async () => {
    const lock = JSON.stringify({ replacements: [{ target: '$lib/other.ts' }] })
    const root = makeApp({ 'composition.lock.json': lock })
    await expect(start(root)).rejects.toThrow(
      'pv-replace: map entry src/lib/util.ts is not in composition.lock.json'
    )
  })

  it('passes the cross-check when the lock lists the target, and skips it when there is no lock', async () => {
    const lock = JSON.stringify({ replacements: [{ target: UTIL_SPEC }] })
    await expect(start(makeApp({ 'composition.lock.json': lock }))).resolves.toBeDefined()
    await expect(start(makeApp())).resolves.toBeDefined()
  })

  it('reports a lock it cannot read as a plain failure naming the file', async () => {
    const root = makeApp({ 'composition.lock.json': '{{' })
    await expect(start(root)).rejects.toThrow('composition.lock.json')
  })
})

describe('AC-7: dev mode reloads the map and invalidates both module graphs', () => {
  interface Node {
    id: string
    file: string
    importers: Set<Node>
  }

  function fakeServer(root: string) {
    const listeners = new Map<string, ((path: string) => void)[]>()
    const invalidated: { env: string; id: string }[] = []
    const sent: unknown[] = []
    const graph = (env: string, nodes: Node[]) => ({
      idToModuleMap: new Map(nodes.map((node) => [node.id, node])),
      invalidateModule: (node: Node) => invalidated.push({ env, id: node.id }),
    })
    const page: Node = {
      id: join(root, 'src/routes/page.ts'),
      file: join(root, 'src/routes/page.ts'),
      importers: new Set(),
    }
    const host: Node = {
      id: join(root, HOST_UTIL),
      file: join(root, HOST_UTIL),
      importers: new Set([page]),
    }
    const ssrOnly: Node = {
      id: join(root, 'src/ssr-only.ts'),
      file: join(root, 'src/ssr-only.ts'),
      importers: new Set(),
    }
    const server: DevServerLike = {
      watcher: {
        add: vi.fn(),
        on(event: string, listener: (path: string) => void) {
          listeners.set(event, [...(listeners.get(event) ?? []), listener])
        },
      },
      ws: { send: (payload: unknown) => sent.push(payload) },
      environments: {
        client: { moduleGraph: graph('client', [host, page]) },
        ssr: { moduleGraph: graph('ssr', [host, page, ssrOnly]) },
      },
    }
    return {
      server,
      invalidated,
      sent,
      emit: (event: string, path: string) => (listeners.get(event) ?? []).forEach((fn) => fn(path)),
    }
  }

  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

  async function started(map: string) {
    const root = makeApp({}, map)
    const plugin = pvReplace({ appRoot: root, debounceMs: 5 })
    await call(plugin, 'buildStart', context())
    const fake = fakeServer(root)
    await (plugin.configureServer as unknown as (server: DevServerLike) => Promise<void>)(
      fake.server
    )
    return { root, plugin, fake }
  }

  it('watches the map file', async () => {
    const { root, fake } = await started(mapJson([]))
    expect(fake.server.watcher.add).toHaveBeenCalledWith(join(root, MAP_FILE))
  })

  it('on an added replacement invalidates the target and its importers in client and ssr, once, then reloads the page', async () => {
    const { root, fake } = await started(mapJson([]))
    writeFileSync(join(root, MAP_FILE), mapJson(UTIL_MAP))
    fake.emit('change', join(root, MAP_FILE))
    fake.emit('change', join(root, MAP_FILE))
    await wait(60)
    const ids = (env: string) =>
      fake.invalidated
        .filter((entry) => entry.env === env)
        .map((entry) => entry.id.replace(root, ''))
    expect(ids('client')).toEqual(['/src/lib/util.ts', '/src/routes/page.ts'])
    expect(ids('ssr')).toEqual(['/src/lib/util.ts', '/src/routes/page.ts'])
    expect(fake.sent).toEqual([{ type: 'full-reload' }])
  })

  it('on a removed replacement restores PV by invalidating the same importers', async () => {
    const { root, fake } = await started(mapJson(UTIL_MAP))
    writeFileSync(join(root, MAP_FILE), mapJson([]))
    fake.emit('change', join(root, MAP_FILE))
    await wait(60)
    expect(fake.invalidated.map((entry) => entry.env)).toContain('ssr')
    expect(fake.sent).toEqual([{ type: 'full-reload' }])
  })

  it('keeps the previous map while a reload fails, shows the error, and recovers on the next good map', async () => {
    const { root, plugin, fake } = await started(mapJson(UTIL_MAP))
    const mapPath = join(root, MAP_FILE)
    writeFileSync(mapPath, 'not json')
    fake.emit('change', mapPath)
    await wait(60)
    expect(JSON.stringify(fake.sent)).toContain('not valid JSON')
    expect(fake.invalidated).toEqual([])
    const abs = join(root, HOST_UTIL)
    const ctx = context({ [abs]: abs })
    expect(await call(plugin, 'resolveId', ctx, abs, undefined, {})).toEqual(
      expect.objectContaining({ id: join(root, CM_UTIL_FILE) })
    )
    writeFileSync(mapPath, mapJson([]))
    fake.emit('change', mapPath)
    await wait(60)
    expect(await call(plugin, 'resolveId', ctx, abs, undefined, {})).toBeNull()
  })

  it('ignores other files and an unchanged map', async () => {
    const { root, fake } = await started(mapJson(UTIL_MAP))
    fake.emit('change', join(root, HOST_UTIL))
    fake.emit('change', join(root, MAP_FILE))
    await wait(60)
    expect(fake.invalidated).toEqual([])
    expect(fake.sent).toEqual([])
  })
})

describe('AC-7: a real dev server picks up an added and a removed replacement', () => {
  it('re-resolves importers in SSR on the next load, with no restart', async () => {
    const root = makeApp({ [MAIN_ENTRY]: IMPORT_UTIL }, mapJson([]))
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, ws: false, watch: null },
      optimizeDeps: { noDiscovery: true },
      resolve: { alias: [{ find: /^\$lib\//, replacement: `${root}/src/lib/` }] },
      plugins: [pvReplace({ appRoot: root, debounceMs: 5 })],
    })
    try {
      const load = async () => ((await server.ssrLoadModule('/src/main.ts')) as { all: string }).all
      expect(await load()).toBe('PV_UTIL')

      const mapPath = join(root, MAP_FILE)
      writeFileSync(mapPath, mapJson(UTIL_MAP))
      server.watcher.emit('change', mapPath)
      await new Promise((done) => setTimeout(done, 80))
      expect(await load()).toBe('CM_UTIL')

      writeFileSync(mapPath, mapJson([]))
      server.watcher.emit('change', mapPath)
      await new Promise((done) => setTimeout(done, 80))
      expect(await load()).toBe('PV_UTIL')
    } finally {
      await server.close()
    }
  })
})
