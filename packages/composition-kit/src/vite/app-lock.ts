// Where a composed app's root and `composition.lock.json` are, for the kit's Vite plugins that
// generate modules from the lock (`pvHooks()`, `pvNav()`): the plugin options, else Vite's root.
import { isAbsolute, join, resolve } from 'node:path'
import { readLock, type CompositionLock } from '../lock.js'

export interface AppLockOptions {
  /** The composed app root (default: Vite's root). */
  appRoot?: string
  /** The lock path (default: `<appRoot>/composition.lock.json`). */
  lockPath?: string
}

export interface AppLock {
  appRoot: () => string
  lockPath: () => string
  /** Call from the plugin's `configResolved` with Vite's root. */
  configure: (root: string) => void
}

export function appLock(options: AppLockOptions): AppLock {
  let appRoot = options.appRoot === undefined ? process.cwd() : resolve(options.appRoot)
  const lockPath = () =>
    options.lockPath === undefined
      ? join(appRoot, 'composition.lock.json')
      : resolve(appRoot, options.lockPath)
  return {
    appRoot: () => appRoot,
    lockPath,
    configure(root) {
      if (options.appRoot === undefined) appRoot = root
      else if (!isAbsolute(options.appRoot)) appRoot = resolve(root, options.appRoot)
    },
  }
}

/** The lock, failing closed: a composed app without its lock would silently ship without the
 * pack's contributions. `what` names what would be missing. */
export function requireLock(plugin: string, lockPath: string, what: string): CompositionLock {
  const read = readLock(lockPath)
  if (read === null) {
    throw new Error(
      `${plugin}: no composition.lock.json at ${lockPath}; run pv-compose for this app first (without it the app would get ${what})`
    )
  }
  if (read.problem !== undefined || read.lock === undefined) {
    throw new Error(`${plugin}: ${read.problem ?? 'unreadable lock'}`)
  }
  return read.lock
}

/** The import specifier for a composed-tree path: `$lib/...` under src/lib, else absolute. */
export function specifierFor(appRoot: string, rel: string): string {
  return rel.startsWith('src/lib/') ? `$lib/${rel.slice('src/lib/'.length)}` : join(appRoot, rel)
}
