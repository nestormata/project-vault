import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Loads a peer dependency (`typescript`, `svelte/compiler`) the way the consuming app resolves
 * it: from the app root first, then from the kit's own location (which, in a real install, is the
 * same node_modules). The parser version therefore always equals the build's. */
export function requirePeer<T>(specifier: string, resolveFrom: string): T {
  const attempts = [createRequire(join(resolveFrom, 'noop.js')), createRequire(import.meta.url)]
  for (const attempt of attempts) {
    try {
      return attempt(specifier) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(
    `@project-vault/composition-kit needs "${specifier}" resolvable from the app root (${resolveFrom}); ` +
      'install it as a dependency of the composed app (it is a peer dependency of the kit)'
  )
}
