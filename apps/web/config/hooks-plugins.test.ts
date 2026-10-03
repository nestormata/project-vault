// @vitest-environment node
// Story 68.6 AC-1 — PV's empty provider for `virtual:pv-hooks/*`: resolves and loads the three
// empty modules, loses to the kit's `enforce: 'pre'` plugin in either plugin order, fails closed on
// a composed tree without the kit plugin, and sits in both config factories' plugin lists.
// Story 68.7 AC-8 — the same contract for `virtual:pv-nav` (`emptyNavModule()`).
import { join } from 'node:path'
import { build, type Plugin, type PluginOption } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  COMPOSED_WITHOUT_KIT_MESSAGE,
  PV_HOOKS_EMPTY_PLUGIN,
  PV_HOOKS_KIT_PLUGIN,
  emptyHooksModuleCode,
  emptyHooksModules,
} from './hooks-plugins.ts'
import {
  COMPOSED_WITHOUT_NAV_KIT_MESSAGE,
  PV_NAV_EMPTY_PLUGIN,
  PV_NAV_KIT_PLUGIN,
  emptyNavModule,
} from './nav-plugins.ts'
import { viteConfig } from './vite.config.ts'
import { vitestConfig } from './vitest.config.ts'

const SOURCES: Record<string, string> = import.meta.glob(['./*.ts', '!./*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

// PV's own tree (no composition.lock.json in config/) and a composed tree fixture (lock present).
const PV_TREE = import.meta.dirname
const COMPOSED_TREE = join(import.meta.dirname, 'fixtures', 'composed-tree')
const ENTRY_ID = 'pv-hooks-test-entry'

const ENTRY =
  "import { hooks, protectedPaths } from 'virtual:pv-hooks/server'\n" +
  "import { hooks as u } from 'virtual:pv-hooks/universal'\n" +
  "import { hooks as c } from 'virtual:pv-hooks/client'\n" +
  'export default JSON.stringify({ hooks, protectedPaths, u, c })\n'

const fakeKit: Plugin = {
  name: PV_HOOKS_KIT_PLUGIN,
  enforce: 'pre',
  resolveId: (id) => (id.startsWith('virtual:pv-hooks/') ? `\0${id}` : null),
  load: (id) =>
    id.startsWith('\0virtual:pv-hooks/')
      ? "export const hooks = { from: 'kit' }\nexport const protectedPaths = { routeIds: ['/(app)/x'], add: [], remove: [] }\n"
      : null,
}

const entry: Plugin = {
  name: 'test-entry',
  resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
  load: (id) => (id === `\0${ENTRY_ID}` ? ENTRY : null),
}

async function bundle(root: string, plugins: Plugin[], entryPlugin = entry): Promise<string> {
  const output = await build({
    root,
    logLevel: 'silent',
    configFile: false,
    plugins: [entryPlugin, ...plugins],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: ENTRY_ID, preserveEntrySignatures: 'strict' },
    },
  })
  const result = Array.isArray(output) ? output[0] : output
  return (result as { output: Array<{ code?: string }> }).output[0]?.code ?? ''
}

async function pluginNames(option: PluginOption | PluginOption[] | undefined): Promise<string[]> {
  const resolved = await option
  if (Array.isArray(resolved)) {
    return (await Promise.all(resolved.map((entry) => pluginNames(entry)))).flat()
  }
  return resolved ? [(resolved as Plugin).name] : []
}

describe('emptyHooksModules (AC-1)', () => {
  it('generates empty hooks, and empty protected paths for the server module', () => {
    expect(emptyHooksModuleCode('server')).toContain('export const protectedPaths')
    expect(emptyHooksModuleCode('client')).not.toContain('protectedPaths')
  })

  it("resolves the three modules in PV's own build", async () => {
    const code = await bundle(PV_TREE, [emptyHooksModules()])
    expect(code).toContain('routeIds: []')
    expect(code).not.toContain('kit')
  })

  it("the kit's pre plugin wins in either plugin order", async () => {
    for (const plugins of [
      [emptyHooksModules(), fakeKit],
      [fakeKit, emptyHooksModules()],
    ]) {
      const code = await bundle(PV_TREE, plugins)
      expect(code).toContain('"kit"')
      expect(code).toContain('/(app)/x')
    }
  })

  it('fails closed on a composed tree (lock file) without pvHooks(); passes with it', async () => {
    await expect(bundle(COMPOSED_TREE, [emptyHooksModules()])).rejects.toThrow(
      COMPOSED_WITHOUT_KIT_MESSAGE
    )
    await expect(bundle(COMPOSED_TREE, [emptyHooksModules(), fakeKit])).resolves.toContain('"kit"')
  })

  it('fails closed on a composed tree whose lock is missing (pv-compose marker in src/)', async () => {
    // Code review 68-6 (AC-1): pv-compose writes src/.pv-compose-generated in every composed tree,
    // including one with CM code under src/lib/server/_cm/.
    const marked = join(import.meta.dirname, 'fixtures', 'marked-tree')
    await expect(bundle(marked, [emptyHooksModules()])).rejects.toThrow(
      COMPOSED_WITHOUT_KIT_MESSAGE
    )
    await expect(bundle(marked, [emptyHooksModules(), fakeKit])).resolves.toContain('"kit"')
  })

  it('fails closed when the factories were given a composed root and the kit plugin is missing', async () => {
    await expect(bundle(PV_TREE, [emptyHooksModules({ composed: true })])).rejects.toThrow(
      COMPOSED_WITHOUT_KIT_MESSAGE
    )
  })

  it('ignores ids it does not own', () => {
    const plugin = emptyHooksModules()
    const resolveId = plugin.resolveId as (id: string) => string | null
    const load = plugin.load as (id: string) => string | null
    expect(resolveId('virtual:pv-hooks/other')).toBeNull()
    expect(resolveId('virtual:pv-inject/x')).toBeNull()
    expect(load('\0virtual:other')).toBeNull()
  })
})

describe('plugin lists (AC-1)', () => {
  it('both factories carry the empty provider between Paraglide and SvelteKit', async () => {
    for (const plugins of [viteConfig().plugins, vitestConfig().plugins]) {
      const names = await pluginNames(plugins)
      const paraglide = names.findIndex((name) => name.includes('paraglide'))
      const empty = names.indexOf(PV_HOOKS_EMPTY_PLUGIN)
      const kit = names.findIndex((name) => name.startsWith('vite-plugin-sveltekit'))
      expect(empty).toBeGreaterThan(paraglide)
      expect(kit).toBeGreaterThan(empty)
    }
  })

  it('the config factories never import the composition kit (AGPL/MIT boundary)', () => {
    for (const [file, source] of Object.entries(SOURCES)) {
      expect(source, file).not.toMatch(/from '@project-vault\/composition-kit/)
    }
  })
})

const NAV_ENTRY_ID = 'pv-nav-test-entry'
const navEntry: Plugin = {
  name: 'test-nav-entry',
  resolveId: (id) => (id === ENTRY_ID ? `\0${NAV_ENTRY_ID}` : null),
  load: (id) =>
    id === `\0${NAV_ENTRY_ID}`
      ? "import delta from 'virtual:pv-nav'\nexport default JSON.stringify(delta)\n"
      : null,
}

const fakeNavKit: Plugin = {
  name: PV_NAV_KIT_PLUGIN,
  enforce: 'pre',
  resolveId: (id) => (id === 'virtual:pv-nav' ? '\0virtual:pv-nav' : null),
  load: (id) =>
    id === '\0virtual:pv-nav'
      ? "export default { primary: [{ op: 'hide', id: 'primary.health', from: 'kit' }] }\n"
      : null,
}

describe('emptyNavModule (Story 68.7 AC-8)', () => {
  it("resolves virtual:pv-nav to an empty delta in PV's own build", async () => {
    const code = await bundle(PV_TREE, [emptyNavModule()], navEntry)
    expect(code).toContain('JSON.stringify({})')
    expect(code).not.toContain('kit')
  })

  it("the kit's pre plugin wins in either plugin order", async () => {
    for (const plugins of [
      [emptyNavModule(), fakeNavKit],
      [fakeNavKit, emptyNavModule()],
    ]) {
      expect(await bundle(PV_TREE, plugins, navEntry)).toContain('primary.health')
    }
  })

  it('fails closed on a composed tree (lock file or marker, or a composed root) without pvNav()', async () => {
    const marked = join(import.meta.dirname, 'fixtures', 'marked-tree')
    for (const [root, plugin] of [
      [COMPOSED_TREE, emptyNavModule()],
      [marked, emptyNavModule()],
      [PV_TREE, emptyNavModule({ composed: true })],
    ] as const) {
      await expect(bundle(root, [plugin], navEntry)).rejects.toThrow(
        COMPOSED_WITHOUT_NAV_KIT_MESSAGE
      )
    }
    await expect(
      bundle(COMPOSED_TREE, [emptyNavModule(), fakeNavKit], navEntry)
    ).resolves.toContain('primary.health')
    expect(COMPOSED_WITHOUT_NAV_KIT_MESSAGE).toBe(
      'composed tree detected but pvNav() from @project-vault/composition-kit/vite is not in the plugin list'
    )
  })

  it('ignores ids it does not own', () => {
    const plugin = emptyNavModule()
    const resolveId = plugin.resolveId as (id: string) => string | null
    const load = plugin.load as (id: string) => string | null
    expect(resolveId('virtual:pv-nav/x')).toBeNull()
    expect(resolveId('virtual:pv-hooks/server')).toBeNull()
    expect(load('\0virtual:other')).toBeNull()
  })

  it('both factories carry it after the hooks provider and before SvelteKit', async () => {
    for (const plugins of [viteConfig().plugins, vitestConfig().plugins]) {
      const names = await pluginNames(plugins)
      const hooks = names.indexOf(PV_HOOKS_EMPTY_PLUGIN)
      const nav = names.indexOf(PV_NAV_EMPTY_PLUGIN)
      const kit = names.findIndex((name) => name.startsWith('vite-plugin-sveltekit'))
      expect(nav).toBe(hooks + 1)
      expect(kit).toBeGreaterThan(nav)
    }
  })
})
