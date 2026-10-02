// @vitest-environment node
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { baseVitestConfig } from '@project-vault/tsconfig/vitest.base'
import type { Adapter } from '@sveltejs/kit'
import type { Plugin, PluginOption } from 'vite'
import { describe, expect, it } from 'vitest'
import { paraglideOptions, sharedAliases, webHostRoot } from './paths.ts'
import { svelteConfig } from './svelte.config.ts'
import { viteConfig } from './vite.config.ts'
import { WEB_HOST_COVERAGE, vitestConfig } from './vitest.config.ts'

// Story 68.2 AC-3: the svelte/vite/vitest configs are factories exported from
// @project-vault/web-host. Every path is computed from where the package is installed (resolved
// through its own `exports`), never from a `../../` walk into the monorepo, so the same factories
// work in PV's workspace and in a consumer's node_modules.

const WEB_DIR = resolve(import.meta.dirname, '..')
const SHARED_SRC = resolve(WEB_DIR, '..', '..', 'packages', 'shared', 'src')
const SHARED_ALIAS = '@project-vault/shared'
const PACKAGE_ROOT = '/opt/web-host'
const VENDORED_SHARED = 'vendor/shared/src'
const VENDORED_MANIFEST = { webHost: { sharedSource: VENDORED_SHARED } }

const FACTORY_SOURCES: Record<string, string> = import.meta.glob(['./*.ts', '!./*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

async function pluginNames(option: PluginOption | PluginOption[] | undefined): Promise<string[]> {
  const resolved = await option
  if (Array.isArray(resolved)) {
    return (await Promise.all(resolved.map((entry) => pluginNames(entry)))).flat()
  }
  return resolved ? [(resolved as Plugin).name] : []
}

describe('web-host config factories: paths (Story 68.2 AC-3)', () => {
  it('locates the package through its own name (Node self-reference via exports)', () => {
    expect(webHostRoot()).toBe(WEB_DIR)
  })

  it('aliases @project-vault/shared to the workspace source inside the monorepo', () => {
    const aliases = sharedAliases()
    expect(aliases).toEqual({
      '@project-vault/shared/node-tls': join(SHARED_SRC, 'node', 'internal-tls-pem.ts'),
      '@project-vault/shared/test-pki': join(SHARED_SRC, 'node', 'test-pki-test-helpers.ts'),
      [SHARED_ALIAS]: join(SHARED_SRC, 'index.ts'),
    })
    // require.resolve() of an absolute path throws when the file does not exist.
    const requireHere = createRequire(import.meta.url)
    for (const target of Object.values(aliases)) expect(requireHere.resolve(target)).toBe(target)
  })

  it('aliases @project-vault/shared to the vendored copy when the manifest says it is packaged', () => {
    const aliases = sharedAliases({ root: PACKAGE_ROOT, manifest: VENDORED_MANIFEST })
    expect(aliases).toMatchObject({
      [SHARED_ALIAS]: join(PACKAGE_ROOT, VENDORED_SHARED, 'index.ts'),
      '@project-vault/shared/node-tls': join(
        PACKAGE_ROOT,
        VENDORED_SHARED,
        'node',
        'internal-tls-pem.ts'
      ),
    })
  })

  it('rejects a packaged shared source that escapes the package root', () => {
    expect(() =>
      sharedAliases({ root: PACKAGE_ROOT, manifest: { webHost: { sharedSource: '../x' } } })
    ).toThrow(/inside the package/)
  })

  it('reads messages from the package and writes compiled messages into the consuming app', () => {
    expect(paraglideOptions('/srv/app')).toEqual({
      project: join(WEB_DIR, 'project.inlang'),
      outdir: join('/srv/app', 'src', 'lib', 'paraglide'),
      strategy: ['cookie', 'baseLocale'],
      emitTsDeclarations: true,
    })
  })

  it('contains no ../../ walk in any factory file', () => {
    expect(Object.keys(FACTORY_SOURCES).length).toBeGreaterThanOrEqual(4)
    for (const [file, source] of Object.entries(FACTORY_SOURCES)) {
      expect(source, file).not.toContain('../../')
    }
  })
})

describe('web-host config factories: svelteConfig (Story 68.2 AC-3)', () => {
  it('uses adapter-node and the computed shared aliases by default', () => {
    const config = svelteConfig()
    expect(config.kit?.adapter?.name).toBe('@sveltejs/adapter-node')
    expect(config.kit?.alias).toEqual(sharedAliases())
  })

  it('replaces only the adapter when a caller passes one', () => {
    const adapter: Adapter = { name: 'custom-adapter', adapt: async () => undefined }
    const config = svelteConfig({ adapter })
    expect(config.kit?.adapter).toBe(adapter)
    expect(config.kit?.alias).toEqual(sharedAliases())
  })

  it('merges caller aliases and kit options without dropping PV aliases', () => {
    const config = svelteConfig({ alias: { $cm: '/abs/cm' }, kit: { appDir: '_custom' } })
    expect(config.kit?.alias).toEqual({ ...sharedAliases(), $cm: '/abs/cm' })
    expect(config.kit?.appDir).toBe('_custom')
  })
})

describe('web-host config factories: viteConfig (Story 68.2 AC-3)', () => {
  it("keeps PV's plugins in PV's order and appends the caller's plugins and aliases", async () => {
    const extra: Plugin = { name: 'cm-extra' }
    const config = viteConfig({ plugins: [extra], resolve: { alias: { $cm: '/abs' } } })
    const names = await pluginNames(config.plugins)
    const tailwind = names.findIndex((name) => name.startsWith('@tailwindcss/vite'))
    const paraglide = names.findIndex((name) => name.includes('paraglide'))
    const kit = names.findIndex((name) => name.startsWith('vite-plugin-sveltekit'))
    expect(tailwind).toBeGreaterThanOrEqual(0)
    expect(paraglide).toBeGreaterThan(tailwind)
    expect(kit).toBeGreaterThan(paraglide)
    expect(names.at(-1)).toBe('cm-extra')
    expect(config.resolve?.alias).toEqual({ $cm: '/abs' })
  })
})

describe('web-host config factories: vitestConfig (Story 68.2 AC-3)', () => {
  it('inlines exactly the coverage defaults of @project-vault/tsconfig/vitest.base', () => {
    expect(WEB_HOST_COVERAGE).toEqual(baseVitestConfig.test?.coverage)
    const coverage = vitestConfig().test?.coverage as Record<string, unknown>
    expect(coverage.reportOnFailure).toBe(true)
    expect(coverage.thresholds).toEqual({ lines: 80, branches: 80, functions: 80, statements: 80 })
  })

  it("merges a caller's test options into PV's", () => {
    const config = vitestConfig({ test: { include: ['cm/**/*.test.ts'] } })
    expect(config.test?.include).toEqual(
      expect.arrayContaining(['src/**/*.test.ts', 'cm/**/*.test.ts'])
    )
    expect(config.test?.environment).toBe('jsdom')
  })
})
