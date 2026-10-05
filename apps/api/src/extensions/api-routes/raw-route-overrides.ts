import {
  applyHookPlan,
  hookPlanForOverride,
  mergeRouteSchema,
  normalizeRouteUrl,
  takeOverride,
  wrapRawHandler,
  type ApiRouteOverrideEntry,
  type ApiRouteTable,
  type RawFn,
  type RawWrapFn,
} from '../../lib/secure-route-overrides.js'
import { secureRawRouteReplacement } from '../../lib/secure-route.js'

/**
 * Story 68.8 AC-8 — the root `onRoute` hook that applies apiRoutes overrides to every route
 * `secureRoute()` did not build: PV's raw routes, the 405 stubs, plugin routes (swagger-ui,
 * CORS) and the HEAD clones Fastify generates for GET routes. Installed on the root instance
 * before any route or route-registering plugin, so it sees every route (Fastify only runs an
 * `onRoute` hook for routes registered after it, in the same or a child context) and runs before
 * `@fastify/swagger`'s and per-context `@fastify/rate-limit`'s own `onRoute` hooks.
 *
 * `replace` swaps the handler, `wrap` gives the extension a `next()` that runs PV's handler;
 * schema and route hooks merge per AC-5. Without `replaceSecurity`, PV's route-level preHandlers
 * and `config.rateLimit` stay. With it, PV builds the secureRoute pipeline from the entry's
 * `security` around the extension's handler and drops the route's own `onRequest`/`preHandler`
 * and `config.rateLimit`; context-level and app-wide hooks still run (Fastify merges them at route
 * build, and an `onRoute` hook cannot remove them).
 *
 * Returns the per-app set of every route key seen (`METHOD url`), used for AC-10's
 * missing-target hints.
 */

type MutableRouteOptions = Record<string, unknown> & {
  method: string | string[]
  url: string
  handler: RawFn
  config?: Record<string, unknown>
  schema?: unknown
}

type HookHost = {
  addHook: (name: 'onRoute', hook: (this: unknown, options: MutableRouteOptions) => void) => unknown
}

function isBuiltBySecureRoute(options: MutableRouteOptions): boolean {
  const marker = new Map(Object.entries(options.config ?? {})).get('pvRoute') as
    { builtBy?: string } | undefined
  return marker?.builtBy === 'secureRoute'
}

/** A HEAD route takes an explicit HEAD entry, else the GET entry for the same URL (AC-7). */
function entryFor(
  table: ApiRouteTable,
  method: string,
  url: string
): { entry: ApiRouteOverrideEntry; key: string } | undefined {
  const key = `${method} ${url}`
  const exact = takeOverride(table, key, 'raw')
  if (exact) return { entry: exact, key }
  if (method !== 'HEAD') return undefined
  const get = table.overrides.get(`GET ${url}`)
  return get ? { entry: get, key: `GET ${url}` } : undefined
}

function withoutRouteSecurity(
  config: Record<string, unknown> | undefined
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([name]) => name !== 'rateLimit'))
}

function applyReplaceSecurity(
  instance: unknown,
  options: MutableRouteOptions,
  entry: ApiRouteOverrideEntry,
  key: string
): void {
  const built = new Map(
    Object.entries(
      secureRawRouteReplacement(
        instance as never,
        { method: entry.method, url: options.url, pvHandler: options.handler },
        entry,
        key
      )
    )
  )
  options.handler = built.get('handler') as RawFn
  options['preHandler'] = built.get('preHandler')
  options['onRequest'] = built.get('onRequest')
  // Story 71.3 AC-1: a delegated replacement also brings its raw-body hashing stage. Only set when
  // present, so a replacement without delegation leaves the raw route's own preParsing alone.
  const preParsing = built.get('preParsing')
  if (preParsing !== undefined) options['preParsing'] = preParsing
  options.config = {
    ...withoutRouteSecurity(options.config),
    pvRoute: { builtBy: 'onRoute', override: entry.declaration.mode, replaceSecurity: true },
  }
}

function bindRequestLog(options: MutableRouteOptions, mode: string): void {
  const binding = (
    request: { log: { child: (bindings: object) => unknown } },
    _reply: unknown,
    done: () => void
  ): void => {
    request.log = request.log.child({ pvRoute: { override: mode } }) as typeof request.log
    done()
  }
  const existing = new Map(Object.entries(options)).get('onRequest')
  options['onRequest'] = [binding, ...(existing === undefined ? [] : [existing].flat())]
}

function applyOverride(
  instance: unknown,
  options: MutableRouteOptions,
  entry: ApiRouteOverrideEntry,
  key: string
): void {
  const mode = entry.declaration.mode
  if (entry.declaration.replaceSecurity) {
    applyReplaceSecurity(instance, options, entry, key)
  } else {
    const cm = entry.implementation.handler as unknown
    options.handler =
      mode === 'replace' ? (cm as RawFn) : wrapRawHandler(key, cm as RawWrapFn, options.handler)
    options.config = { ...options.config, pvRoute: { builtBy: 'onRoute', override: mode } }
    bindRequestLog(options, mode)
  }
  options.schema = mergeRouteSchema(
    options.schema,
    entry.implementation.schema,
    entry.declaration.schema
  )
  applyHookPlan(options, hookPlanForOverride(entry))
}

export function installRawRouteOverrideHook(
  fastify: HookHost,
  table: ApiRouteTable | undefined
): Set<string> {
  const seen = new Set<string>()
  fastify.addHook('onRoute', function (this: unknown, options: MutableRouteOptions) {
    if (typeof options.method !== 'string') return
    const url = normalizeRouteUrl('', options.url)
    seen.add(`${options.method} ${url}`)
    if (!table || isBuiltBySecureRoute(options)) return
    const match = entryFor(table, options.method, url)
    if (match) applyOverride(this, options, match.entry, match.key)
  })
  return seen
}
