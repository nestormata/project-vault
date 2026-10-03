// Story 68.6 AC-1 — PV's own provider for the three hook contribution virtual modules
// (`virtual:pv-hooks/server|universal|client`). In PV's build every contribution is empty, so the
// hooks files compose PV's hooks with nothing and behave exactly as before. In a composed app the
// composition kit's `pvHooks()` plugin (`enforce: 'pre'`) resolves the same ids first and wins.
//
// Fail closed: a composed tree WITHOUT `pvHooks()` would silently ship with no CM hooks and no
// derived protection for CM `(app)` routes, so this provider refuses to build one.
//
// PV (AGPL) never imports the composition kit (MIT); the kit plugin is recognized by name only.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export const PV_HOOKS_PREFIX = 'virtual:pv-hooks/'
/** The name of the composition kit's hooks plugin (`@project-vault/composition-kit/vite`). */
export const PV_HOOKS_KIT_PLUGIN = 'pv-composition-kit:hooks'
export const PV_HOOKS_EMPTY_PLUGIN = 'pv-web-host:empty-hooks'

const HOOK_FILES = new Set(['server', 'universal', 'client'])
const requireFromHere = createRequire(import.meta.url)

export const COMPOSED_WITHOUT_KIT_MESSAGE =
  'composed tree detected but pvHooks() from @project-vault/composition-kit/vite is not in the plugin list'

function fileExists(path: string): boolean {
  try {
    // require.resolve() of an absolute path succeeds only when the file exists.
    requireFromHere.resolve(path)
    return true
  } catch {
    return false
  }
}

/** A composed tree: its lock, or the marker pv-compose writes in every directory it owns (src/,
 * so also a tree with CM code under src/lib/server/_cm/ whose lock went missing). */
function isComposedTree(root: string): boolean {
  return (
    fileExists(join(root, 'composition.lock.json')) ||
    fileExists(join(root, 'src', '.pv-compose-generated'))
  )
}

/** The generated module for one hooks file in PV's own build. */
export function emptyHooksModuleCode(file: string): string {
  const hooks = 'export const hooks = Object.freeze({})\n'
  return file === 'server'
    ? `${hooks}export const protectedPaths = Object.freeze({ routeIds: [], add: [], remove: [] })\n`
    : hooks
}

export interface EmptyHooksOptions {
  /** Set by the config factories when they build a composed app (`composedRoot`). */
  composed?: boolean
}

export function emptyHooksModules(options: EmptyHooksOptions = {}): Plugin {
  return {
    name: PV_HOOKS_EMPTY_PLUGIN,
    enforce: 'post',
    configResolved(config) {
      const kitPresent = config.plugins.some((plugin) => plugin.name === PV_HOOKS_KIT_PLUGIN)
      if (!kitPresent && (options.composed === true || isComposedTree(config.root))) {
        throw new Error(COMPOSED_WITHOUT_KIT_MESSAGE)
      }
    },
    resolveId(id) {
      if (!id.startsWith(PV_HOOKS_PREFIX)) return null
      return HOOK_FILES.has(id.slice(PV_HOOKS_PREFIX.length)) ? `\0${id}` : null
    },
    load(id) {
      if (!id.startsWith(`\0${PV_HOOKS_PREFIX}`)) return null
      return emptyHooksModuleCode(id.slice(PV_HOOKS_PREFIX.length + 1))
    },
  }
}
