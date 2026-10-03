import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'
import { apply } from '../apply.js'
import { applyIncremental, signaturesOf, type Signatures } from '../incremental.js'
import { plan, type ComposeOptions } from '../plan.js'
import type { DevServerLike } from './dev-server.js'
import { createComposeQueue, type ComposeBatch } from './queue.js'

export { pvReplace, PV_ORIGINAL_PREFIX } from './replace.js'
export type { PvReplaceOptions } from './replace.js'
export type { DevServerLike } from './dev-server.js'

const DEFAULT_DEBOUNCE_MS = 100
const MANIFEST_BASENAME = 'pv-ui.manifest'

// Virtual modules registered by later stories (68-4 `virtual:pv-inject/*`, 68-5, 68-7). This story
// provides only the registry and the invalidation hook they plug into.
const virtualPrefixes = new Set<string>()

// Story 68.6: the signatures of every tree this process composed, by app root. A dev-server restart
// (pvHooks() restarts it when the hooks or protected-path contribution changes) creates a new plugin
// instance in the same process; it then brings the existing tree up to date incrementally instead
// of swapping in a fresh copy, which would drop files other plugins generated inside it (for
// example the Paraglide output under src/lib/paraglide).
const composedTrees = new Map<string, Signatures>()

/** Registers a virtual module id prefix (for example `virtual:pv-inject/`) so a manifest change
 * invalidates every module under it, in both the client and the SSR module graphs. */
export function registerVirtualModulePrefix(prefix: string): void {
  virtualPrefixes.add(prefix)
}

/** Invalidates every registered virtual module in the `client` and `ssr` environments' module
 * graphs (`server.environments.<env>.moduleGraph`, not the legacy `server.moduleGraph` alone). */
export function invalidateVirtualModules(server: DevServerLike): void {
  const prefixes = [...virtualPrefixes].flatMap((prefix) => [prefix, `\0${prefix}`])
  const environments = new Map(Object.entries(server.environments))
  for (const name of ['client', 'ssr']) {
    const graph = environments.get(name)?.moduleGraph
    if (graph === undefined) continue
    for (const [id, module] of graph.idToModuleMap) {
      if (prefixes.some((prefix) => id.startsWith(prefix))) graph.invalidateModule(module as never)
    }
  }
}

export interface PvComposeDevOptions extends ComposeOptions {
  /** Quiet period before a burst of file events becomes one compose (default 100 ms). */
  debounceMs?: number
}

interface ServerFs {
  server?: { fs?: { allow?: string[] } }
}

function inside(root: string, path: string): boolean {
  const real = resolve(path)
  return real === root || real.startsWith(`${root}${sep}`)
}

/** The Vite dev plugin: runs the same `plan()`/`apply()` the CLI runs (one implementation, two
 * entry points), watches the pack and web-host, and re-composes incrementally. A compose error
 * keeps the last good tree, is logged and shown in Vite's error overlay, and recovers on the next
 * good compose. */
export function pvComposeDev(options: PvComposeDevOptions): Plugin {
  const packRoot = realpathSync(options.packRoot)
  const hostRoot = realpathSync(options.hostDir)
  const treeKey = resolve(options.appRoot)
  const state: { signatures?: Signatures; failed: boolean } = { failed: false }
  const previous = composedTrees.get(treeKey)
  if (previous !== undefined) state.signatures = previous

  async function compose(): Promise<{ problems: string[] }> {
    const composed = await plan(options)
    if (composed.problems.length > 0) return { problems: composed.problems }
    if (state.signatures === undefined) apply(composed, options.appRoot)
    state.signatures =
      state.signatures === undefined
        ? signaturesOf(composed)
        : applyIncremental(composed, options.appRoot, state.signatures)
    composedTrees.set(treeKey, state.signatures)
    return { problems: [] }
  }

  return {
    name: 'pv-compose-dev',
    apply: 'serve',
    config() {
      // Vite concatenates arrays when it merges `config` results, so Kit's own allow list stays.
      return { server: { fs: { allow: [packRoot] } } }
    },
    configResolved(resolved: unknown) {
      // Belt and braces: Kit replaces the list it computed, so make sure the pack is in the result.
      const allow = (resolved as ServerFs).server?.fs?.allow
      if (allow !== undefined && !allow.includes(packRoot)) allow.push(packRoot)
    },
    async configureServer(server: unknown) {
      const dev = server as DevServerLike
      const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
      const report = (problems: string[]): void => {
        const message = problems.join('\n')
        log(`pv-compose: ${message}`)
        dev.ws.send({ type: 'error', err: { message, stack: '' } })
        state.failed = true
      }
      const run = async (batch?: ComposeBatch): Promise<void> => {
        try {
          const { problems } = await compose()
          if (problems.length > 0) return report(problems)
          if (batch?.full === true) invalidateVirtualModules(dev)
          if (state.failed) dev.ws.send({ type: 'full-reload' })
          state.failed = false
        } catch (error) {
          report([(error as Error).message])
        }
      }
      await run()
      const queue = createComposeQueue({
        debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
        run,
      })
      dev.watcher.add([packRoot, hostRoot])
      for (const event of ['add', 'change', 'unlink']) {
        dev.watcher.on(event, (path: string) => {
          if (!inside(packRoot, path) && !inside(hostRoot, path)) return
          queue.schedule(path, join(path).includes(MANIFEST_BASENAME))
        })
      }
    },
  }
}

export { pvHooks, hooksModuleCode, PV_HOOKS_PLUGIN_NAME, PV_HOOKS_PREFIX } from './hooks.js'
export type { PvHooksOptions } from './hooks.js'
