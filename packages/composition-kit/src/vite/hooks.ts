// Story 68.6 AC-1 — `pvHooks()`: generates `virtual:pv-hooks/server|universal|client` for a
// composed app from its `composition.lock.json` (written by `pv-compose`). Each module re-exports
// the materialized CM hook file's namespace as `hooks` (an empty object when the pack has no such
// file); the server module also exports the protected-path data (derived `(app)` route ids and the
// manifest's add/remove). `enforce: 'pre'`, so it wins over web-host's own empty provider.
//
// Every path in generated code is emitted with JSON.stringify, never spliced into a template.
// In dev a change to the lock's hooks or protected-path contribution restarts the dev server:
// SvelteKit caches the server hooks behind a module-level `init_promise`, so invalidating the
// virtual module alone is not guaranteed to re-run them.
import { isAbsolute, join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { readLock, type CompositionLock } from '../lock.js'
import { registerVirtualModulePrefix } from './index.js'

export const PV_HOOKS_PREFIX = 'virtual:pv-hooks/'
/** web-host's empty provider recognizes the kit plugin by this name. */
export const PV_HOOKS_PLUGIN_NAME = 'pv-composition-kit:hooks'
const KINDS = ['server', 'universal', 'client'] as const
type Kind = (typeof KINDS)[number]

export interface PvHooksOptions {
  /** The composed app root (default: Vite's root). */
  appRoot?: string
  /** The lock path (default: `<appRoot>/composition.lock.json`). */
  lockPath?: string
}

type Contributions = CompositionLock['contributions']

function readContributions(lockPath: string): Contributions | undefined {
  const read = readLock(lockPath)
  if (read?.problem !== undefined) throw new Error(`pvHooks(): ${read.problem}`)
  return read?.lock?.contributions
}

/** The import specifier for a composed-tree path: `$lib/...` under src/lib, else absolute. */
function specifierFor(appRoot: string, rel: string): string {
  return rel.startsWith('src/lib/') ? `$lib/${rel.slice('src/lib/'.length)}` : join(appRoot, rel)
}

/** The generated module for one hooks file. */
function hooksExport(file: string | undefined, appRoot: string): string {
  return file === undefined
    ? 'export const hooks = Object.freeze({})\n'
    : `export * as hooks from ${JSON.stringify(specifierFor(appRoot, file))}\n`
}

function protectedPathsExport(paths: Contributions['protectedPaths'] | undefined): string {
  const data = {
    routeIds: (paths?.derived ?? []).map((route) => route.routeId),
    add: paths?.add ?? [],
    remove: paths?.remove ?? [],
  }
  return `export const protectedPaths = Object.freeze(${JSON.stringify(data)})\n`
}

/** The generated module for one hooks file. */
export function hooksModuleCode(
  kind: Kind,
  contributions: Contributions | undefined,
  appRoot: string
): string {
  const file = new Map(Object.entries(contributions?.hooks ?? {})).get(kind)
  const hooks = hooksExport(file, appRoot)
  return kind === 'server'
    ? `${hooks}${protectedPathsExport(contributions?.protectedPaths)}`
    : hooks
}

function signature(contributions: Contributions | undefined): string {
  return JSON.stringify([contributions?.hooks ?? {}, contributions?.protectedPaths ?? null])
}

interface DevServer {
  watcher: {
    add: (path: string) => unknown
    on: (event: string, cb: (path: string) => void) => unknown
  }
  restart: () => Promise<void>
}

export function pvHooks(options: PvHooksOptions = {}): Plugin {
  registerVirtualModulePrefix(PV_HOOKS_PREFIX)
  let appRoot = options.appRoot === undefined ? process.cwd() : resolve(options.appRoot)
  const lockPath = () =>
    options.lockPath === undefined
      ? join(appRoot, 'composition.lock.json')
      : resolve(appRoot, options.lockPath)
  return {
    name: PV_HOOKS_PLUGIN_NAME,
    enforce: 'pre',
    configResolved(config) {
      if (options.appRoot === undefined) appRoot = config.root
      else if (!isAbsolute(options.appRoot)) appRoot = resolve(config.root, options.appRoot)
    },
    resolveId(id) {
      if (!id.startsWith(PV_HOOKS_PREFIX)) return null
      const kind = id.slice(PV_HOOKS_PREFIX.length)
      return (KINDS as readonly string[]).includes(kind) ? `\0${id}` : null
    },
    load(id) {
      if (!id.startsWith(`\0${PV_HOOKS_PREFIX}`)) return null
      const kind = id.slice(PV_HOOKS_PREFIX.length + 1) as Kind
      return hooksModuleCode(kind, readContributions(lockPath()), appRoot)
    },
    configureServer(server) {
      const dev = server as unknown as DevServer
      const lock = lockPath()
      let last = signature(readContributions(lock))
      dev.watcher.add(lock)
      dev.watcher.on('change', (path: string) => {
        if (resolve(path) !== lock) return
        const next = signature(readContributions(lock))
        if (next === last) return
        last = next
        void dev.restart()
      })
    },
  }
}
