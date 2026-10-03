/**
 * Story 68.8 (M7) — API routes an extension adds to PV's own API router, or PV routes it
 * overrides (`replace`) or wraps (`wrap`), all running inside PV's own security pipeline.
 *
 * Declarations are plain data in `ExtensionManifest.apiRoutes`; functions and schema objects live
 * in `ExtensionHooks.apiRoutes`, keyed by `"<METHOD> <url>"` (the same declaration + keyed-handler
 * shape `moduleDataRoutes` uses). So the host can read the override table without calling
 * `hooksFactory()`.
 *
 * Validation is integrity only: well-formed methods and URLs, no duplicate keys, known entry keys,
 * a handler behind every declaration. There is no URL prefix, count cap, capability declaration
 * or allowlist. `apiRoutes` replaces the deprecated `moduleDataRoutes`.
 *
 * The handler signatures are structural, so this MIT package has no Fastify dependency. `req` and
 * `reply` are type parameters with minimal structural defaults; annotate them with Fastify's own
 * `FastifyRequest`/`FastifyReply` in an extension that depends on Fastify.
 */

/** Every HTTP method an `apiRoutes` entry may declare. */
export const API_ROUTE_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const
export type ApiRouteMethod = (typeof API_ROUTE_METHODS)[number]

/** `"<METHOD> <url>"`, for example `"GET /api/v1/cm/documents"`. */
export type ApiRouteKey = `${ApiRouteMethod} ${string}`

/** The per-route Fastify hook phases an extension may contribute functions to. */
export const API_ROUTE_HOOK_PHASES = ['onRequest', 'preValidation', 'preHandler', 'onSend'] as const
export type ApiRouteHookPhase = (typeof API_ROUTE_HOOK_PHASES)[number]

export type ApiRouteOrgRole = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * The same semantics as PV's own `secureRoute` security options. Omitted fields take PV's
 * defaults (authenticated, org-scoped, viewer or above, 60 requests per minute per user).
 * `capability` is passed to the registered capability gate unchanged; it is not limited to PV's
 * own capability ids.
 */
export type ApiRouteSecurity = {
  requireAuth?: boolean
  requireOrgScope?: boolean
  minimumRole?: ApiRouteOrgRole
  allowedRoles?: ApiRouteOrgRole[]
  requireMfa?: boolean
  requirePlatformOperator?: boolean
  writeAuditEvent?:
    boolean | { eventType: string; resourceType?: string; resourceIdFromParams?: string }
  rateLimit?: false | { max: number; timeWindowMs?: number; key?: string }
  capability?: string
}

/** A new route at any URL. Registered through PV's security pipeline. */
export type ApiRouteAddDeclaration = {
  method: ApiRouteMethod
  url: string
  options?: {
    security?: ApiRouteSecurity
    bodyLimit?: number
    /** `true` when `hooks.apiRoutes.routes[key].schema` supplies the route schema. */
    schema?: boolean
    /** The hook phases `hooks.apiRoutes.routes[key].hooks` supplies functions for. */
    hooks?: ApiRouteHookPhase[]
  }
}

/**
 * An override of an existing PV route at the same method and URL.
 *
 * - `replace`: the extension's handler runs in place of PV's business handler.
 * - `wrap`: the extension's handler gets a `next()` that runs PV's business handler.
 *
 * `security` is honoured only together with `replaceSecurity: true`; it then replaces PV's
 * route-level security for that route. `replaceSecurity` is recorded by the host, never refused.
 */
export type ApiRouteOverrideDeclaration = {
  method: ApiRouteMethod
  url: string
  mode: 'replace' | 'wrap'
  schema?: 'extend' | 'replace'
  hooks?: { prepend?: ApiRouteHookPhase[]; append?: ApiRouteHookPhase[] }
  replaceSecurity?: boolean
  security?: ApiRouteSecurity
}

/**
 * The request-lifecycle phases an extension may contribute app-wide (global) hook functions to:
 * the same closed list as the per-route phases (`API_ROUTE_HOOK_PHASES`). `onRoute`, `onRegister`, `onReady` and `onClose`
 * are not request phases and are not accepted.
 */
export type AppHookPhase = ApiRouteHookPhase

/**
 * Story 68.14 — app-level API behaviour: PV's global hooks, error handler and not-found handler,
 * changed with the same `wrap`/`replace` model as routes.
 *
 * - `hooks.prepend`: the declared phases' functions run on every request BEFORE PV's own app-wide
 *   hooks (vault guard, structured logging, metrics). They also run while the vault is sealed.
 * - `hooks.append`: they run after PV's last app-wide hook and before PV's route plugins.
 * - `errorHandler` / `notFoundHandler`: `replace` makes the extension's function the handler;
 *   `wrap` gives it a `next()` that runs PV's own handler. A function that throws or rejects falls
 *   back to PV's handler with the original error.
 */
export type ApiRoutesAppDeclaration = {
  hooks?: { prepend?: AppHookPhase[]; append?: AppHookPhase[] }
  errorHandler?: 'wrap' | 'replace'
  notFoundHandler?: 'wrap' | 'replace'
}

export type ApiRoutesDeclaration = {
  add?: ApiRouteAddDeclaration[]
  override?: ApiRouteOverrideDeclaration[]
  /** Story 68.14: app-wide hooks, error handler and not-found handler. */
  app?: ApiRoutesAppDeclaration
}

/** The host's request transaction. At runtime it is a drizzle `PgTransaction`. */
export type HostTransaction = object

export type ApiRouteAuthContext = {
  userId: string
  orgId: string
  sessionId: string
  orgRole: ApiRouteOrgRole
  isPlatformOperator: boolean
}

/**
 * The context an authenticated route's handler receives: PV's resolved session, PV's request
 * transaction (`app.current_org_id` set for org-scoped routes), post-commit callbacks and the
 * route's audit config. Public routes (`requireAuth: false`) receive an empty object.
 */
export type ApiRouteContext = {
  auth: ApiRouteAuthContext
  tx?: HostTransaction
  onPostCommit: (callback: () => void | Promise<void>) => void
  audit?: { eventType?: string; resourceType?: string }
}

export type ApiRoutePublicContext = Record<string, never>

/** A minimal structural request. Annotate with Fastify's `FastifyRequest` if you use Fastify. */
export type ApiRouteRequest = {
  method: string
  url: string
  params: unknown
  query: unknown
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

/** A minimal structural reply. Annotate with Fastify's `FastifyReply` if you use Fastify. */
export type ApiRouteReply = {
  readonly sent: boolean
  code: (statusCode: number) => unknown
  header: (name: string, value: unknown) => unknown
  send: (payload?: unknown) => unknown
}

export type ApiRouteHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  ctx: ApiRouteContext | ApiRoutePublicContext,
  req: Req,
  reply: Reply
) => unknown

/**
 * `next()` runs PV's business handler with the same context and resolves with its result. It may
 * be called more than once (PV's handler runs again, in the same transaction) or never (the wrap
 * then behaves like `replace`). A call after the wrap's own returned promise settled rejects.
 */
export type ApiRouteWrapHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  ctx: ApiRouteContext | ApiRoutePublicContext,
  req: Req,
  reply: Reply,
  next: () => Promise<unknown>
) => unknown

/** The handler of an override on a PV route that is not built by `secureRoute` (a raw route). */
export type RawRouteHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  req: Req,
  reply: Reply
) => unknown

export type RawRouteWrapHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  req: Req,
  reply: Reply,
  next: () => Promise<unknown>
) => unknown

export type ApiRouteHookFn<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  req: Req,
  reply: Reply,
  ...rest: unknown[]
) => unknown

/**
 * Any function. The host calls it with the signature that fits the entry: `ApiRouteHandler` for an
 * `add`, or a `replace` of a `secureRoute` route; `ApiRouteWrapHandler` for a `wrap` of one;
 * `RawRouteHandler`/`RawRouteWrapHandler` for a `replace`/`wrap` of a raw PV route. Typed loosely
 * here so an extension can annotate its parameters with its own (for example Fastify) types.
 */
export type ApiRouteAnyFunction = (...args: never[]) => unknown

export type ApiRouteImplementation = {
  handler: ApiRouteAnyFunction
  /**
   * A schema PV's validator and serializer compilers accept: today a Zod 4 schema object per part
   * (`params`, `querystring`, `body`, `headers`, `response`), including `zod/v4` from zod 3.25+.
   * PV compiles it while the API boots; a schema PV cannot compile fails the boot.
   */
  schema?: unknown
  /** Functions per declared hook phase, with Fastify's hook signature for that phase. */
  hooks?: Partial<Record<ApiRouteHookPhase, ApiRouteAnyFunction | ApiRouteAnyFunction[]>>
}

/** `errorHandler` with `replace`: owns the response for every error. */
export type AppErrorHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  error: Error,
  req: Req,
  reply: Reply
) => unknown

/** `errorHandler` with `wrap`: `next()` runs PV's own error handler with the same error. */
export type AppErrorWrapHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  error: Error,
  req: Req,
  reply: Reply,
  next: () => Promise<unknown>
) => unknown

/** `notFoundHandler` with `replace`. */
export type AppNotFoundHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  req: Req,
  reply: Reply
) => unknown

/** `notFoundHandler` with `wrap`: `next()` runs PV's own not-found handler. */
export type AppNotFoundWrapHandler<Req = ApiRouteRequest, Reply = ApiRouteReply> = (
  req: Req,
  reply: Reply,
  next: () => Promise<unknown>
) => unknown

/** The functions behind `apiRoutes.app`. Typed loosely, like `ApiRouteImplementation.handler`. */
export type AppBehaviourHooks = {
  hooks?: Partial<Record<AppHookPhase, ApiRouteAnyFunction | ApiRouteAnyFunction[]>>
  errorHandler?: ApiRouteAnyFunction
  notFoundHandler?: ApiRouteAnyFunction
}

export type ApiRoutesHooks = {
  routes?: Partial<Record<ApiRouteKey, ApiRouteImplementation>>
  /** Story 68.14: the functions behind `ExtensionManifest.apiRoutes.app`. */
  app?: AppBehaviourHooks
}
