// Story 68.7 AC-8 — `pvNav()`: generates `virtual:pv-nav` for a composed app from its
// `composition.lock.json` (written by `pv-compose`): a re-export of the materialized `nav.ts`
// (`contributions.nav`), so Vite's module graph tracks edits to it (no restart needed in dev).
// `export default {}` when the pack has no nav, or when the lock was written against an older
// web-host that applies no nav delta (no `navIdsHost`; Story 68-3 behaviour). `enforce: 'pre'`, so
// it wins over web-host's own empty provider, which refuses to build a composed tree without it.
// The module reaches both the server and the client bundle (the nav renders in the browser too),
// so `nav.ts` must not import server-only code: Kit's server-only guard rejects that.
import type { Plugin } from 'vite'
import type { CompositionLock } from '../lock.js'
import { appLock, requireLock, specifierFor, type AppLockOptions } from './app-lock.js'
import { registerVirtualModulePrefix } from './virtual-modules.js'

export const PV_NAV_MODULE = 'virtual:pv-nav'
/** web-host's empty provider recognizes the kit plugin by this name. */
export const PV_NAV_PLUGIN_NAME = 'pv-composition-kit:nav'

export type PvNavOptions = AppLockOptions

/** The generated `virtual:pv-nav` module for a lock. */
export function navModuleCode(lock: CompositionLock, appRoot: string): string {
  const nav = lock.contributions.nav
  if (nav === null || lock.navIdsHost === undefined) return 'export default {}\n'
  return `export { default } from ${JSON.stringify(specifierFor(appRoot, nav))}\n`
}

export function pvNav(options: PvNavOptions = {}): Plugin {
  registerVirtualModulePrefix(PV_NAV_MODULE)
  const app = appLock(options)
  return {
    name: PV_NAV_PLUGIN_NAME,
    enforce: 'pre',
    configResolved(config) {
      app.configure(config.root)
    },
    resolveId(id) {
      return id === PV_NAV_MODULE ? `\0${PV_NAV_MODULE}` : null
    },
    load(id) {
      if (id !== `\0${PV_NAV_MODULE}`) return null
      const lock = requireLock('pvNav()', app.lockPath(), "PV's nav without the pack's nav delta")
      return navModuleCode(lock, app.appRoot())
    },
  }
}
