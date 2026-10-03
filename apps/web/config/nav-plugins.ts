// Story 68.7 AC-8 — PV's own provider for the nav delta virtual module (`virtual:pv-nav`). In PV's
// build the delta is empty, so every nav surface renders PV's own nav exactly as before. In a
// composed app the composition kit's `pvNav()` plugin (`enforce: 'pre'`) resolves the same id first
// and re-exports CM's `nav.ts`.
//
// Fail closed (68-6 pattern): a composed tree WITHOUT `pvNav()` would silently ship PV's nav with
// none of CM's changes, so this provider refuses to build one.
//
// PV (AGPL) never imports the composition kit (MIT); the kit plugin is recognized by name only.
import type { Plugin } from 'vite'
import { isComposedTree } from './hooks-plugins.ts'

export const PV_NAV_MODULE = 'virtual:pv-nav'
/** The name of the composition kit's nav plugin (`@project-vault/composition-kit/vite`). */
export const PV_NAV_KIT_PLUGIN = 'pv-composition-kit:nav'
export const PV_NAV_EMPTY_PLUGIN = 'pv-web-host:empty-nav'

export const COMPOSED_WITHOUT_NAV_KIT_MESSAGE =
  'composed tree detected but pvNav() from @project-vault/composition-kit/vite is not in the plugin list'

export interface EmptyNavOptions {
  /** Set by the config factories when they build a composed app (`composedRoot`). */
  composed?: boolean
}

export function emptyNavModule(options: EmptyNavOptions = {}): Plugin {
  return {
    name: PV_NAV_EMPTY_PLUGIN,
    enforce: 'post',
    configResolved(config) {
      const kitPresent = config.plugins.some((plugin) => plugin.name === PV_NAV_KIT_PLUGIN)
      if (!kitPresent && (options.composed === true || isComposedTree(config.root))) {
        throw new Error(COMPOSED_WITHOUT_NAV_KIT_MESSAGE)
      }
    },
    resolveId(id) {
      return id === PV_NAV_MODULE ? `\0${PV_NAV_MODULE}` : null
    },
    load(id) {
      return id === `\0${PV_NAV_MODULE}` ? 'export default {}\n' : null
    },
  }
}
