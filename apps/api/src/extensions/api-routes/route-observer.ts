import { normalizeRouteUrl } from '../../lib/secure-route-overrides.js'

/**
 * Story 68.14 AC-2 — the per-route collector behind the runtime route audit. `createApp()` installs
 * it as a second root `onRoute` hook (after the override hook, so it reads the FINAL `config`)
 * only when `AppOptions.routeObserver` is set; production installs nothing.
 *
 * `origin` follows the marker `secureRoute()` leaves in `config.pvRoute`:
 * - `core`: built by `secureRoute()` for PV;
 * - `extension-add`: built by `secureRoute()` for an extension `add` entry;
 * - `plugin`: no `secureRoute` marker (PV raw routes, 405 stubs, swagger-ui, CORS, HEAD clones);
 * - `hook-registered`: reserved for a raw route an extension introduces through app-level hook
 *   code. The extension contract gives hooks no Fastify instance, so no code path produces it
 *   today; the classifier handles it so the origin is named if that ever changes.
 */

export type RouteOrigin = 'core' | 'extension-add' | 'plugin' | 'hook-registered'

export type ObservedRoute = {
  method: string
  /** The full normalized URL (prefix included), as Fastify serves it. */
  url: string
  pvRoute?: unknown
  origin: RouteOrigin
}

export type RouteObserver = (route: ObservedRoute) => void

type RouteOptions = {
  method: string | string[]
  url: string
  config?: Record<string, unknown>
}

type HookHost = { addHook: (name: 'onRoute', hook: (options: RouteOptions) => void) => unknown }

function originOf(marker: unknown): RouteOrigin {
  const pvRoute = marker as { builtBy?: string; added?: boolean } | undefined
  if (pvRoute?.builtBy !== 'secureRoute') return 'plugin'
  return pvRoute.added === true ? 'extension-add' : 'core'
}

export function installRouteObserver(fastify: HookHost, observer: RouteObserver | undefined): void {
  if (!observer) return
  fastify.addHook('onRoute', (options) => {
    const marker = new Map(Object.entries(options.config ?? {})).get('pvRoute')
    const url = normalizeRouteUrl('', options.url)
    for (const method of [options.method].flat()) {
      observer({ method, url, pvRoute: marker, origin: originOf(marker) })
    }
  })
}
