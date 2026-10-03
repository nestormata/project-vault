import { $ZodType } from 'zod/v4/core'
import type {
  ApiRouteAddDeclaration,
  ApiRouteHookPhase,
  ApiRouteImplementation,
  ApiRouteOverrideDeclaration,
} from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'

/**
 * Story 68.8 (M7) — the per-app apiRoutes override table, its key normalization and the pieces
 * `secureRoute()` and the root `onRoute` hook use to apply an override: business-handler swap
 * (`replace`/`wrap` with a lifetime-guarded `next()`), schema merge and route-hook merge.
 *
 * The table is built once per `createApp()` from the loaded extension and decorated on the root
 * instance (`pvApiRouteOverrides`); there is no module-global mutable table, because tests build
 * many apps in one process. Entries are frozen; only the per-app `consumed` set changes.
 */

export type ExtensionApiRouteBootReason =
  | 'extension_api_route_drift'
  | 'extension_api_route_collision'
  | 'extension_api_route_schema_rejected'

/**
 * Thrown from `createApp()` when the loaded extension's apiRoutes cannot be applied consistently
 * (a missing override target, an undeclared collision, a schema the host compiler rejects). Its
 * message lists route keys only, never handler source or schema contents. The boot fails even
 * when `VAULT_EXTENSIONS_REQUIRED` is false: routes already mutated cannot be un-registered, so
 * the API cannot start with a partially applied extension.
 */
export class ExtensionApiRouteBootError extends Error {
  constructor(
    public readonly reason: ExtensionApiRouteBootReason,
    message: string
  ) {
    super(message)
    this.name = 'ExtensionApiRouteBootError'
  }
}

export type ApiRouteOverrideEntry = Readonly<{
  key: string
  method: string
  url: string
  declaration: ApiRouteOverrideDeclaration
  implementation: ApiRouteImplementation
}>

export type ApiRouteAddEntry = Readonly<{
  key: string
  method: string
  url: string
  declaration: ApiRouteAddDeclaration
  implementation: ApiRouteImplementation
}>

export type ApiRouteTable = Readonly<{
  extensionName: string
  overrides: ReadonlyMap<string, ApiRouteOverrideEntry>
  adds: readonly ApiRouteAddEntry[]
  /** Per-app: override keys applied by `secureRoute()` or the root `onRoute` hook. */
  consumed: Set<string>
  /** Per-app: which mechanism applied each consumed override (status endpoint `target`). */
  targets: Map<string, 'secureRoute' | 'raw'>
}>

/** The route URL as Fastify serves it under `ignoreTrailingSlash: true`. */
export function normalizeRouteUrl(prefix: string, url: string): string {
  const joined = `${prefix}${url}`
  if (joined === '') return '/'
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined
}

/** `"<METHOD> <prefix><url>"`, normalized: the key overrides, rate limits and the registry use. */
export function routeKey(method: string, prefix: string, url: string): string {
  return `${method} ${normalizeRouteUrl(prefix, url)}`
}

function implementationFor(
  routes: ReadonlyMap<string, ApiRouteImplementation | undefined>,
  method: string,
  url: string
): ApiRouteImplementation {
  const implementation = routes.get(`${method} ${url}`)
  // registerExtension() already proved every declaration has an implementation; this only keeps
  // the table total for a hand-built test state.
  return implementation ?? { handler: () => undefined }
}

export function buildApiRouteTable(state: ExtensionState): ApiRouteTable | undefined {
  if (state.status !== 'loaded') return undefined
  const declaration = state.manifest.apiRoutes
  if (!declaration) return undefined
  const routes = new Map<string, ApiRouteImplementation | undefined>(
    Object.entries(state.hooks.apiRoutes?.routes ?? {})
  )
  const overrides = new Map<string, ApiRouteOverrideEntry>()
  for (const entry of declaration.override ?? []) {
    const key = routeKey(entry.method, '', entry.url)
    overrides.set(
      key,
      Object.freeze({
        key,
        method: entry.method,
        url: normalizeRouteUrl('', entry.url),
        declaration: entry,
        implementation: implementationFor(routes, entry.method, entry.url),
      })
    )
  }
  const adds = (declaration.add ?? []).map((entry) =>
    Object.freeze({
      key: `${entry.method} ${entry.url}`,
      method: entry.method,
      url: entry.url,
      declaration: entry,
      implementation: implementationFor(routes, entry.method, entry.url),
    })
  )
  return Object.freeze({
    extensionName: state.manifest.name,
    overrides,
    adds: Object.freeze(adds),
    consumed: new Set<string>(),
    targets: new Map<string, 'secureRoute' | 'raw'>(),
  })
}

/** Looks up an override and marks it consumed (AC-10 fails the boot for unconsumed ones). */
export function takeOverride(
  table: ApiRouteTable | undefined,
  key: string,
  target: 'secureRoute' | 'raw' = 'secureRoute'
): ApiRouteOverrideEntry | undefined {
  const entry = table?.overrides.get(key)
  if (entry) {
    table?.consumed.add(key)
    table?.targets.set(key, target)
  }
  return entry
}

type NextFn = () => Promise<unknown>
export type BusinessFn = (ctx: unknown, req: unknown, reply: unknown) => unknown
export type BusinessWrapFn = (ctx: unknown, req: unknown, reply: unknown, next: NextFn) => unknown
export type RawFn = (this: unknown, req: unknown, reply: unknown) => unknown
export type RawWrapFn = (req: unknown, reply: unknown, next: NextFn) => unknown

/**
 * Builds a wrap's `next()`. It always returns a promise: the after-settle guard rejects, and a
 * synchronous throw from PV's handler also becomes a rejection (the Promise executor turns a throw
 * into one), while PV's handler still starts synchronously inside the `next()` call.
 */
function guardedNext(key: string, isSettled: () => boolean, run: () => unknown): NextFn {
  return () =>
    new Promise<unknown>((resolve, reject) => {
      if (isSettled()) {
        reject(new Error(`apiRoutes wrap next() called after the handler settled: ${key}`))
        return
      }
      resolve(run())
    })
}

/**
 * `wrap` for a `secureRoute` business handler. `next()` runs PV's handler with the same context,
 * request and reply. It may be called more than once or never; a call after the wrap's own
 * promise settled rejects instead of running PV's handler against a finished transaction (Q9).
 */
export function wrapBusinessHandler(
  key: string,
  cm: BusinessWrapFn,
  pv: BusinessFn
): (ctx: unknown, req: unknown, reply: unknown) => Promise<unknown> {
  return async (ctx, req, reply) => {
    let settled = false
    const next = guardedNext(
      key,
      () => settled,
      () => pv(ctx, req, reply)
    )
    try {
      return await cm(ctx, req, reply, next)
    } finally {
      settled = true
    }
  }
}

/** `wrap` for a raw PV route handler; PV's handler keeps Fastify's `this`. */
export function wrapRawHandler(
  key: string,
  cm: RawWrapFn,
  pv: RawFn
): (this: unknown, req: unknown, reply: unknown) => Promise<unknown> {
  return async function (this: unknown, req: unknown, reply: unknown) {
    let settled = false
    const next = guardedNext(
      key,
      () => settled,
      () => pv.call(this, req, reply)
    )
    try {
      return await cm(req, reply, next)
    } finally {
      settled = true
    }
  }
}

type SchemaParts = Record<string, unknown>

function asParts(value: unknown): SchemaParts {
  return value && typeof value === 'object' ? (value as SchemaParts) : {}
}

/**
 * AC-5: `replace` uses the CM schema verbatim; `extend` merges per part (`params`, `querystring`,
 * `body`, `headers`) and per response status code, CM winning for what it supplies.
 */
export function mergeRouteSchema(
  pvSchema: unknown,
  cmSchema: unknown,
  mode: 'extend' | 'replace' | undefined
): unknown {
  if (mode === undefined) return pvSchema
  if (mode === 'replace') return cmSchema
  const merged = new Map(Object.entries(asParts(pvSchema)))
  for (const [part, value] of Object.entries(asParts(cmSchema))) {
    if (part === 'response') {
      merged.set(part, { ...asParts(merged.get('response')), ...asParts(value) })
    } else {
      merged.set(part, value)
    }
  }
  return Object.fromEntries(merged)
}

/** AC-5: CM hook functions before (`prepend`) or after (`append`) PV's own hooks of a phase. */
export function mergeRouteHooks(
  pvValue: unknown,
  prepend: readonly unknown[],
  append: readonly unknown[]
): unknown {
  if (prepend.length === 0 && append.length === 0) return pvValue
  const pv = pvValue === undefined ? [] : [pvValue].flat()
  return [...prepend, ...pv, ...append]
}

/** The implementation's functions for the given phases, as arrays (phases with none omitted). */
export function collectRouteHookFunctions(
  implementation: ApiRouteImplementation,
  phases: readonly ApiRouteHookPhase[]
): Map<ApiRouteHookPhase, unknown[]> {
  const hooks = new Map<string, unknown>(Object.entries(implementation.hooks ?? {}))
  const collected = new Map<ApiRouteHookPhase, unknown[]>()
  for (const phase of phases) {
    const value = hooks.get(phase)
    if (value !== undefined) collected.set(phase, [value].flat())
  }
  return collected
}

export type RouteHookPlan = {
  prepend: Map<ApiRouteHookPhase, unknown[]>
  append: Map<ApiRouteHookPhase, unknown[]>
}

export const ROUTE_HOOK_PHASES: readonly ApiRouteHookPhase[] = [
  'onRequest',
  'preValidation',
  'preHandler',
  'onSend',
]

export function hookPlanForOverride(entry: ApiRouteOverrideEntry): RouteHookPlan {
  return {
    prepend: collectRouteHookFunctions(
      entry.implementation,
      entry.declaration.hooks?.prepend ?? []
    ),
    append: collectRouteHookFunctions(entry.implementation, entry.declaration.hooks?.append ?? []),
  }
}

export function hookPlanForAdd(entry: ApiRouteAddEntry): RouteHookPlan {
  return {
    prepend: new Map(),
    append: collectRouteHookFunctions(entry.implementation, entry.declaration.options?.hooks ?? []),
  }
}

/**
 * Applies a hook plan to a route options object (secureRoute's or a raw route's). Every phase
 * gets CM's prepended functions, then PV's own, then CM's appended ones.
 */
export function applyHookPlan(routeOptions: Record<string, unknown>, plan: RouteHookPlan): void {
  for (const phase of ROUTE_HOOK_PHASES) {
    const merged = mergeRouteHooks(
      new Map(Object.entries(routeOptions)).get(phase),
      plan.prepend.get(phase) ?? [],
      plan.append.get(phase) ?? []
    )
    if (merged !== undefined) Object.assign(routeOptions, { [phase]: merged })
  }
}

/** True for a schema the host's validator/serializer compilers accept (a Zod 4 schema). */
export function isHostSchema(value: unknown): boolean {
  return value instanceof $ZodType
}

function rejectedPart(schema: unknown): string | undefined {
  for (const [part, value] of Object.entries(asParts(schema))) {
    if (part !== 'response') {
      if (!isHostSchema(value)) return part
      continue
    }
    for (const [status, responseSchema] of Object.entries(asParts(value))) {
      if (!isHostSchema(responseSchema)) return `response.${status}`
    }
  }
  return undefined
}

function schemaProblem(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'the schema must be an object of parts (params, querystring, body, headers, response)'
  }
  const part = rejectedPart(schema)
  return part === undefined
    ? undefined
    : `${part} is not a schema the host compiler accepts (expected a Zod 4 schema)`
}

/**
 * AC-3/AC-5 eager check, run inside `createApp()` before any route registers: Fastify compiles
 * route schemas only at `ready()`/`listen()`, after `main.ts` started its workers. Every CM schema
 * part must be a schema the host compilers accept; otherwise the boot fails naming the route.
 */
export function assertHostAcceptsApiRouteSchemas(table: ApiRouteTable | undefined): void {
  if (!table) return
  const entries = [
    ...[...table.overrides.values()].map((entry) => ({ kind: 'override', entry })),
    ...table.adds.map((entry) => ({ kind: 'add', entry })),
  ]
  for (const { kind, entry } of entries) {
    if (entry.implementation.schema === undefined) continue
    const problem = schemaProblem(entry.implementation.schema)
    if (problem !== undefined) {
      throw new ExtensionApiRouteBootError(
        'extension_api_route_schema_rejected',
        `apiRoutes ${kind} ${entry.key}: schema rejected by the host compiler: ${problem}`
      )
    }
  }
}
