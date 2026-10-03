import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeWorld, manifest, sha, useWorlds, writeAll } from '../../tests/compose-test-helpers.js'
import {
  invalidateVirtualModules,
  pvComposeDev,
  registerVirtualModulePrefix,
  type DevServerLike,
} from './index.js'

const KIT_DEFAULT = '/kit/default'

useWorlds()

const DASHBOARD = 'src/routes/(app)/dashboard/+page.svelte'

type Listener = (path: string) => void

function fakeServer() {
  const listeners = new Map<string, Listener[]>()
  const sent: unknown[] = []
  const invalidated: { env: string; id: string }[] = []
  const graph = (env: string, ids: string[]) => ({
    idToModuleMap: new Map(ids.map((id) => [id, { id }])),
    invalidateModule: (module: { id: string }) => invalidated.push({ env, id: module.id }),
  })
  const server: DevServerLike = {
    watcher: {
      add: () => undefined,
      on(event: string, listener: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
    },
    ws: { send: (payload: unknown) => sent.push(payload) },
    environments: {
      client: { moduleGraph: graph('client', ['\0virtual:pv-inject/a', '/src/other.ts']) },
      ssr: { moduleGraph: graph('ssr', ['\0virtual:pv-inject/b']) },
    },
  }
  return {
    server,
    sent,
    invalidated,
    emit: (event: string, path: string) => (listeners.get(event) ?? []).forEach((fn) => fn(path)),
  }
}

describe('pvComposeDev: fs.allow (AC-13)', () => {
  it("adds the pack directory in addition to Kit's own allow list, never replacing it", async () => {
    const world = makeWorld()
    const plugin = pvComposeDev({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: manifest(),
    })
    const fromConfig = (
      plugin.config as (config: unknown) => { server: { fs: { allow: string[] } } }
    )({
      server: { fs: { allow: [KIT_DEFAULT] } },
    })
    expect(fromConfig.server.fs.allow).toContain(world.pack)
    const resolved = { server: { fs: { allow: [KIT_DEFAULT] } } }
    ;(plugin.configResolved as (config: unknown) => void)(resolved)
    expect(resolved.server.fs.allow).toEqual([KIT_DEFAULT, world.pack])
    ;(plugin.configResolved as (config: unknown) => void)(resolved)
    expect(resolved.server.fs.allow).toEqual([KIT_DEFAULT, world.pack])
  })
})

describe('invalidateVirtualModules (AC-13)', () => {
  it('invalidates registered virtual modules in both the client and the SSR module graphs', () => {
    registerVirtualModulePrefix('virtual:pv-inject/')
    const { server, invalidated } = fakeServer()
    invalidateVirtualModules(server)
    expect(invalidated).toEqual([
      { env: 'client', id: '\0virtual:pv-inject/a' },
      { env: 'ssr', id: '\0virtual:pv-inject/b' },
    ])
  })
})

describe('pvComposeDev: watching (AC-13)', () => {
  async function started() {
    const world = makeWorld({ packFiles: { [DASHBOARD]: 'cm v1\n' } })
    const pack = manifest({
      routes: { overrides: [{ path: DASHBOARD, hostSha256: sha(world, DASHBOARD) }] },
    })
    const fake = fakeServer()
    const plugin = pvComposeDev({
      appRoot: world.app,
      packRoot: world.pack,
      hostDir: world.host,
      manifest: pack,
      debounceMs: 2,
    })
    await (plugin.configureServer as (server: DevServerLike) => Promise<void>)(fake.server)
    return { world, fake, plugin }
  }

  it('composes on start, mirrors a changed pack file, and keeps the last good tree on an error', async () => {
    const { world, fake } = await started()
    expect(readFileSync(join(world.app, DASHBOARD), 'utf8')).toBe('cm v1\n')
    writeFileSync(join(world.pack, DASHBOARD), 'cm v2\n')
    fake.emit('change', join(world.pack, DASHBOARD))
    await new Promise((done) => setTimeout(done, 80))
    expect(readFileSync(join(world.app, DASHBOARD), 'utf8')).toBe('cm v2\n')

    // An integrity failure (an undeclared collision) must not crash the server or wipe the tree.
    writeAll(world.pack, { 'src/routes/login/+page.svelte': 'x\n' })
    fake.emit('add', join(world.pack, 'src/routes/login/+page.svelte'))
    await new Promise((done) => setTimeout(done, 80))
    expect(readFileSync(join(world.app, DASHBOARD), 'utf8')).toBe('cm v2\n')
    expect(JSON.stringify(fake.sent)).toContain('Collision')
    expect(readFileSync(join(world.app, 'src/routes/login/+page.svelte'), 'utf8')).toBe(
      '<h1>Login</h1>\n'
    )
  })

  it('ignores events outside the pack and the host', async () => {
    const { world, fake } = await started()
    fake.emit('change', join(world.app, 'src/lib/util.ts'))
    await new Promise((done) => setTimeout(done, 30))
    expect(fake.sent).toEqual([])
  })
})
