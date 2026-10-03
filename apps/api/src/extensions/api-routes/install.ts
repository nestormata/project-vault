import { OperationalEvent } from '@project-vault/shared'
import { operationalLog } from '../../lib/logger.js'
import {
  ExtensionApiRouteBootError,
  assertHostAcceptsApiRouteSchemas,
  buildApiRouteTable,
  type ApiRouteAddEntry,
  type ApiRouteOverrideEntry,
  type ApiRouteTable,
} from '../../lib/secure-route-overrides.js'
import { secureAddedApiRoute, type SecureRouteRegistration } from '../../lib/secure-route.js'
import type { ExtensionState } from '../loader.js'
import {
  appChangeLabels,
  appChanges,
  appStatus,
  installAppHooks,
  logAppOverrides,
} from './app-behaviour.js'
import { installRawRouteOverrideHook } from './raw-route-overrides.js'

/**
 * Story 68.8 (M7) — wires the loaded extension's apiRoutes into `createApp()`:
 *
 * 1. `installApiRoutes()` runs right after the extension loads, before any route: it builds the
 *    per-app override table, checks every CM schema part against the host compilers, decorates
 *    the table and the per-app `secureRoute` registration collector on the root instance and
 *    installs the root `onRoute` hook for raw routes.
 * 2. `registerApiRouteAdds()` runs as the LAST route registration: it registers `add` routes in
 *    their own encapsulated plugin after a collision check, then fails the boot for any override
 *    that matched no PV route, then records what was applied (boot log lines).
 *
 * Drift and collisions fail the boot whatever `VAULT_EXTENSIONS_REQUIRED` says: by then routes
 * were already mutated and cannot be un-registered, so the API cannot start with a partially
 * applied extension.
 */

type BootLogger = Parameters<typeof operationalLog>[0]

type ApiRoutesHost = {
  decorate: (name: string, value: unknown) => unknown
  addHook: (name: string, hook: never) => unknown
  register: (plugin: (instance: AddPluginHost) => Promise<void>) => PromiseLike<unknown>
}

type AddPluginHost = {
  hasRoute: (options: { method: string; url: string }) => boolean
}

export type ApiRoutesRuntime = {
  table: ApiRouteTable | undefined
  registry: Map<string, SecureRouteRegistration>
  /** Every route key Fastify registered (`METHOD url`), in registration order. */
  routeIndex: Set<string>
}

export function installApiRoutes(fastify: ApiRoutesHost, state: ExtensionState): ApiRoutesRuntime {
  const table = buildApiRouteTable(state)
  assertHostAcceptsApiRouteSchemas(table)
  const registry = new Map<string, SecureRouteRegistration>()
  if (table) fastify.decorate('pvApiRouteOverrides', table)
  fastify.decorate('pvSecureRouteRegistry', registry)
  const routeIndex = installRawRouteOverrideHook(fastify as never, table)
  // Per-app, in registration order: what the missing-target hints and Story 68-14's runtime route
  // audit read. Never consulted by a request path.
  fastify.decorate('pvRouteIndex', routeIndex)
  // Story 68.14: prepended app-level hooks go on the root now, before every PV plugin hook.
  installAppHooks(fastify as never, table?.app, 'prepend')
  return { table, registry, routeIndex }
}

/**
 * Story 68.14: appended app-level hooks. Called right after the vault-guard slot (the guard
 * plugin when `vaultGuardEnabled`, an empty slot otherwise) and before the first route plugin, so
 * the hooks are on the root before any route context copies them.
 */
export function installAppendedAppHooks(fastify: ApiRoutesHost, runtime: ApiRoutesRuntime): void {
  installAppHooks(fastify as never, runtime.table?.app, 'append')
}

const METHOD_ORDER = ['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

/**
 * Sorted by URL, then method with HEAD first: a user HEAD registered after its GET would collide
 * with Fastify's auto-HEAD route, while one registered before it suppresses the auto-HEAD.
 */
function addOrder(left: ApiRouteAddEntry, right: ApiRouteAddEntry): number {
  return (
    left.url.localeCompare(right.url) ||
    METHOD_ORDER.indexOf(left.method) - METHOD_ORDER.indexOf(right.method)
  )
}

function collisionError(entry: ApiRouteAddEntry): ExtensionApiRouteBootError {
  return new ExtensionApiRouteBootError(
    'extension_api_route_collision',
    `apiRoutes.add ${entry.key} collides with an existing route; declare it under apiRoutes.override with mode 'replace' or 'wrap' to change it`
  )
}

function isDuplicatedRouteError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'FST_ERR_DUPLICATED_ROUTE'
}

function registerAdds(instance: AddPluginHost, table: ApiRouteTable): void {
  for (const entry of [...table.adds].sort(addOrder)) {
    if (instance.hasRoute({ method: entry.method, url: entry.url })) throw collisionError(entry)
    try {
      secureAddedApiRoute(instance as never, entry)
    } catch (error) {
      if (isDuplicatedRouteError(error)) throw collisionError(entry)
      throw error
    }
  }
}

// The plugin returns a promise so `register` rejects on a collision: the Promise executor turns
// registerAdds' synchronous throw into that rejection.
function addPlugin(table: ApiRouteTable) {
  return (instance: AddPluginHost): Promise<void> =>
    new Promise<void>((resolve) => {
      registerAdds(instance, table)
      resolve()
    })
}

const DOCS_GATED_PATHS = ['/api/v1/openapi.json', '/api/v1/docs']

function shapeOf(key: string): string {
  return key.replaceAll(/\/:[^/]+/g, '/:')
}

function targetHint(key: string, routeIndex: Set<string>, docsEnabled: boolean): string {
  const sameShape = [...routeIndex].find(
    (known) => known !== key && shapeOf(known) === shapeOf(key)
  )
  if (sameShape) return `PV has ${sameShape}`
  const url = key.slice(key.indexOf(' ') + 1)
  const docsGated = !docsEnabled && DOCS_GATED_PATHS.some((path) => url.startsWith(path))
  return docsGated
    ? 'no PV route; registered only when API docs are enabled: ENABLE_API_DOCS'
    : 'no PV route'
}

function assertAllOverridesConsumed(runtime: ApiRoutesRuntime, docsEnabled: boolean): void {
  const table = runtime.table
  if (!table) return
  const missing = [...table.overrides.keys()]
    .filter((key) => !table.consumed.has(key))
    .sort((left, right) => left.localeCompare(right))
  if (missing.length === 0) return
  const listed = missing
    .map((key) => `${key} (${targetHint(key, runtime.routeIndex, docsEnabled)})`)
    .join(', ')
  throw new ExtensionApiRouteBootError(
    'extension_api_route_drift',
    `apiRoutes.override targets not found: ${listed}; the API cannot start with a partially applied extension`
  )
}

function overrideRecord(entry: ApiRouteOverrideEntry, table: ApiRouteTable) {
  const declaration = entry.declaration
  return {
    method: entry.method,
    url: entry.url,
    mode: declaration.mode,
    replaceSecurity: declaration.replaceSecurity === true,
    ...(declaration.schema ? { schema: declaration.schema } : {}),
    ...(declaration.hooks ? { hooks: declaration.hooks } : {}),
    ...(declaration.security?.capability ? { capability: declaration.security.capability } : {}),
    target: table.targets.get(entry.key) ?? 'secureRoute',
  }
}

/** AC-6 (2): the `apiRoutes` object of `GET /api/v1/admin/extensions/status` (keys and flags). */
export function apiRoutesStatus(table: ApiRouteTable | undefined) {
  if (!table) return { added: [], overrides: [], app: appStatus(undefined) }
  return {
    app: appStatus(table.app),
    added: [...table.adds].sort(addOrder).map((entry) => {
      const capability = entry.declaration.options?.security?.capability
      return { method: entry.method, url: entry.url, ...(capability ? { capability } : {}) }
    }),
    overrides: [...table.overrides.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => overrideRecord(entry, table)),
  }
}

function logApplied(table: ApiRouteTable, logger: BootLogger): void {
  const status = apiRoutesStatus(table)
  if (status.added.length === 0 && status.overrides.length === 0 && !appChanges(table.app).length) {
    return
  }
  const added = status.added.map((entry) => `${entry.method} ${entry.url}`)
  const overrides = status.overrides.map(({ method, url, ...flags }) => ({
    key: `${method} ${url}`,
    ...flags,
  }))
  operationalLog(
    logger,
    'info',
    OperationalEvent.EXTENSION_API_ROUTES_APPLIED,
    'Extension apiRoutes applied',
    {
      extensionName: table.extensionName,
      addedCount: added.length,
      overrideCount: overrides.length,
      added,
      overrides,
      app: appChangeLabels(table.app),
    }
  )
  logAppOverrides(table.extensionName, table.app, logger)
  for (const entry of status.overrides.filter((override) => override.replaceSecurity)) {
    operationalLog(
      logger,
      'warn',
      OperationalEvent.EXTENSION_API_ROUTE_REPLACE_SECURITY,
      'Extension apiRoutes override replaces the security of a PV route (recorded, not refused)',
      { extensionName: table.extensionName, method: entry.method, url: entry.url, mode: entry.mode }
    )
  }
}

/**
 * AC-18: after the prefixed default keys, two default keys are equal only for the same route. The
 * remaining overlap is an extension route whose effective bucket key equals a PV route's (for
 * example an `add` of `POST /callback` and PV's explicit `'POST /callback'` SSO key).
 */
function warnSharedRateLimitKeys(
  table: ApiRouteTable,
  registry: Map<string, SecureRouteRegistration>,
  logger: BootLogger
): void {
  const registrations = [...registry.values()]
  const pv = registrations.filter((entry) => entry.origin === 'pv' && entry.rateLimitKey !== null)
  for (const route of registrations.filter((entry) => entry.origin !== 'pv')) {
    for (const match of pv.filter(
      (entry) => entry.rateLimitKey === route.rateLimitKey && entry.key !== route.key
    )) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.EXTENSION_API_ROUTE_SHARED_DEFAULT_KEY,
        'Extension route shares a rate-limit bucket with a PV route; set rateLimit.key to separate them',
        {
          extensionName: table.extensionName,
          route: route.key,
          rateLimitKey: route.rateLimitKey,
          sharedWith: match.key,
        }
      )
    }
  }
}

export async function registerApiRouteAdds(
  fastify: ApiRoutesHost,
  runtime: ApiRoutesRuntime,
  options: { logger: BootLogger; docsEnabled: boolean }
): Promise<void> {
  const table = runtime.table
  if (!table) return
  await fastify.register(addPlugin(table))
  assertAllOverridesConsumed(runtime, options.docsEnabled)
  logApplied(table, options.logger)
  warnSharedRateLimitKeys(table, runtime.registry, options.logger)
}
