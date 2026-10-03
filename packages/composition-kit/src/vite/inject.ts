import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import {
  generateBehaviorModule,
  generatePointModule,
  type CodegenInjection,
} from '../inject-codegen.js'
import { registerVirtualModulePrefix } from './virtual-modules.js'

/** One module per point: `virtual:pv-inject/<point name>`. */
export const POINT_PREFIX = 'virtual:pv-inject/'
/** The load and action tables PV's `injectLoad` / `injectActions` read. */
export const BEHAVIOR_ID = 'virtual:pv-inject-behavior'
const RESOLVED = '\0'
const LOCK_FILE = 'composition.lock.json'

export interface PvInjectOptions {
  /** The composition lock to read the contributions from (default `<vite root>/composition.lock.json`).
   * Read on every load, so a re-compose in dev is picked up after the virtual modules are invalidated. */
  lockPath?: string
  /** Contributions given directly (tests, tooling) instead of read from a lock. */
  injections?: readonly CodegenInjection[]
}

function readInjections(path: string): CodegenInjection[] {
  if (!existsSync(path)) return []
  const lock = JSON.parse(readFileSync(path, 'utf8')) as { injections?: unknown }
  return Array.isArray(lock.injections) ? (lock.injections as CodegenInjection[]) : []
}

function matches(id: string): boolean {
  return id.startsWith(POINT_PREFIX) || id === BEHAVIOR_ID
}

/** The Vite plugin that turns a pack's `injections` into the virtual modules PV's `<InjectionPoint>`
 * and `injectLoad`/`injectActions` import (design section 5). It runs `enforce: 'pre'`, so it wins
 * over PV's own empty provider; every point it has nothing for still resolves, to an empty list.
 * It resolves the same ids in the client and the SSR environments (Vite 8 plugins apply to both). */
export function pvInject(options: PvInjectOptions = {}): Plugin {
  let root = process.cwd()
  registerVirtualModulePrefix(POINT_PREFIX)
  registerVirtualModulePrefix(BEHAVIOR_ID)
  const injections = (): readonly CodegenInjection[] =>
    options.injections ?? readInjections(options.lockPath ?? join(root, LOCK_FILE))
  return {
    name: 'pv-inject',
    enforce: 'pre',
    configResolved(config: { root: string }) {
      root = config.root
    },
    resolveId(id: string) {
      return matches(id) ? `${RESOLVED}${id}` : null
    },
    load(id: string) {
      if (!id.startsWith(RESOLVED)) return null
      const virtual = id.slice(RESOLVED.length)
      if (virtual === BEHAVIOR_ID) return generateBehaviorModule(injections())
      if (!virtual.startsWith(POINT_PREFIX)) return null
      const point = virtual.slice(POINT_PREFIX.length)
      return generatePointModule(
        point,
        injections().filter((entry) => entry.point === point)
      )
    },
  } as Plugin
}
