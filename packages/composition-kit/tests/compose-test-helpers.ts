import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach } from 'vitest'
import { sha256Hex } from '../src/hash.js'
import type { CompatibilityTuple, UiPackManifest } from '../src/types.js'

export const MARKER =
  '/* @project-vault/web-host: shared-source (the next line is rewritten when packed or composed) */'
const KIT_DIR = import.meta.dirname.replace(/\/tests$/, '')

export const TUPLE: CompatibilityTuple = {
  schemaVersion: 1,
  pvRelease: '1.5.0',
  extensionApiVersion: '3.25.0',
  kitVersion: '0.1.0',
  toolchain: { kit: '2.70.3', svelte: '5.57.1', vite: '8.3.1', typescript: '6.0.3' },
  apiImageTag: 'ghcr.io/nestormata/project-vault/api:1.5.0',
}

export const HOST_FILES: Record<string, string | Buffer> = {
  'src/app.html': '<html>%sveltekit.body%</html>\n',
  'src/app.css': `@import "tailwindcss" source(none);\n@source "./**/*.{svelte,ts}";\n${MARKER}\n@source "../vendor/shared/src/**/*.ts";\n.pv { color: red; }\n`,
  'src/hooks.server.ts': 'export const handle = ({ event, resolve }) => resolve(event)\n',
  'src/lib/util.ts': 'export const fmt = (n: number) => String(n)\n',
  'src/lib/components/shell/GlobalSearch.svelte': '<input placeholder="search" />\n',
  'src/lib/server/auth.ts': 'export const requireUser = () => true\n',
  'src/routes/+layout.svelte': '<slot />\n',
  'src/routes/login/+page.svelte': '<h1>Login</h1>\n',
  'src/routes/(app)/dashboard/+page.svelte': '<h1>Dashboard</h1>\n',
  'src/routes/(app)/dashboard/+page.server.ts': 'export const load = () => ({ x: 1 })\n',
  'src/routes/(app)/extensions/panels/[slot]/[...subpath]/+page.svelte': '<p>legacy</p>\n',
  'src/routes/api/v1/[...path]/+server.ts': 'export const GET = () => new Response()\n',
  'static/favicon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  'messages/en.json':
    '{\n  "$schema": "https://inlang.com/schema/inlang-message-format",\n  "app_name": "Project Vault",\n  "greeting": "Hello"\n}\n',
  'messages/es.json':
    '{\n  "$schema": "https://inlang.com/schema/inlang-message-format",\n  "app_name": "Project Vault",\n  "greeting": "Hola"\n}\n',
  'project.inlang/settings.json': '{\n  "baseLocale": "en",\n  "locales": ["en", "es"]\n}\n',
  'vendor/shared/src/index.ts': 'export const shared = 1\n',
}

export interface World {
  root: string
  host: string
  pack: string
  app: string
  tuple: CompatibilityTuple
}

export interface WorldOptions {
  hostFiles?: Record<string, string | Buffer | null>
  packFiles?: Record<string, string | Buffer>
  tuple?: Partial<CompatibilityTuple>
  /** Versions "installed" in the app's node_modules (defaults match the tuple). */
  appVersions?: Record<string, string>
  hostDependencies?: Record<string, string>
}

const roots: string[] = []

export function useWorlds(): void {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
}

export function writeAll(root: string, files: Record<string, string | Buffer | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function install(root: string, name: string, version: string): void {
  writeAll(root, { [`node_modules/${name}/package.json`]: JSON.stringify({ name, version }) })
}

export function makeWorld(options: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'kit-world-'))
  roots.push(root)
  const tuple: CompatibilityTuple = { ...TUPLE, ...options.tuple }
  const hostDependencies = options.hostDependencies ?? { undici: '7.29.1' }
  const host = join(root, 'host')
  const pack = join(root, 'pack')
  const app = join(root, 'app')
  writeAll(host, {
    ...HOST_FILES,
    'manifests/compatibility.json': `${JSON.stringify(tuple, null, 2)}\n`,
    'package.json': JSON.stringify({
      name: '@project-vault/web-host',
      dependencies: hostDependencies,
    }),
    ...options.hostFiles,
  })
  mkdirSync(pack, { recursive: true })
  writeAll(pack, options.packFiles ?? {})
  writeAll(app, { 'package.json': JSON.stringify({ name: 'app', dependencies: hostDependencies }) })
  const versions: Record<string, string> = {
    '@sveltejs/kit': tuple.toolchain.kit,
    svelte: tuple.toolchain.svelte,
    vite: tuple.toolchain.vite,
    typescript: tuple.toolchain.typescript,
    '@project-vault/composition-kit': tuple.kitVersion,
    ...hostDependencies,
    ...options.appVersions,
  }
  for (const [name, version] of Object.entries(versions)) install(app, name, version)
  return { root, host, pack, app, tuple }
}

const HOST_FILE_MAP = new Map(Object.entries(HOST_FILES))

/** The bytes of one of the default web-host files. */
export function hostBytes(hostRel: string): string | Buffer {
  const content = HOST_FILE_MAP.get(hostRel)
  if (content === undefined) throw new Error(`no default web-host file ${hostRel}`)
  return content
}

export function sha(_world: World, hostRel: string): string {
  const content = hostBytes(hostRel)
  return sha256Hex(typeof content === 'string' ? Buffer.from(content) : content)
}

export function shaOf(content: string | Buffer): string {
  return sha256Hex(typeof content === 'string' ? Buffer.from(content) : content)
}

export function manifest(extra: Partial<UiPackManifest> = {}): UiPackManifest {
  return { host: { pvRelease: TUPLE.pvRelease }, ...extra }
}

/** Where the kit's own typescript and svelte resolve from in tests (the app has no node_modules
 * with them, only version stubs). */
export const RESOLVE_FROM = KIT_DIR
