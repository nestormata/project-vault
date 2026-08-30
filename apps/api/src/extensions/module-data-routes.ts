import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import type {
  ModuleDataRequestContext,
  ModuleDataResult,
  ModuleDataRouteHandler,
} from '@project-vault/extension-api'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../lib/fastify-app.js'
import { secureRoute, type SecureRouteContext } from '../lib/secure-route.js'
import { operationalLog } from '../lib/logger.js'
import { raceWithTimeout } from '../lib/race-with-timeout.js'
import { getExtensionStatus } from './loader.js'

/**
 * Story 29.4 AC5 — the exact same interim numeric default `extension-panel.ts`'s
 * `RENDER_PANEL_TIMEOUT_MS` already established for `onRenderPanel()`, reused verbatim rather
 * than a new, uncoordinated timeout value — mirrors `module-action-handler.ts`'s own
 * `MODULE_ACTION_TIMEOUT_MS` precedent (a locally-duplicated constant with this same comment,
 * rather than importing an unexported symbol from `extension-panel.ts`).
 */
const MODULE_DATA_ROUTE_TIMEOUT_MS = 10_000

type ModuleDataLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>

export type ModuleDataAttemptOutcome =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'failed'; subReason: 'threw' | 'timed_out' | 'malformed_result' }

/**
 * Story 29.4 AC5 — a minimal shape check, mirroring `finalizePanelResult()`'s own `typeof
 * inner.result?.html !== 'string'` check: a non-object return, or an object whose `body` is
 * `undefined` with no `status` either, is malformed. Anything else (including a `body` that is
 * itself `undefined` but paired with an explicit `status`) is passed through — the module's own
 * handler is trusted-but-arbitrary in-process code (Invariant 1), not re-validated beyond this.
 */
function isMalformedModuleDataResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const candidate = value as { status?: unknown; body?: unknown }
  return candidate.body === undefined && candidate.status === undefined
}

function logModuleDataRouteFailed(
  logger: ModuleDataLogger,
  routeKey: string,
  subReason: 'threw' | 'timed_out' | 'malformed_result'
): void {
  // AC5: the extension's own thrown error text/stack (or timeout detail) is never included
  // here — logged server-side only, as a fixed-enum subReason, mirroring `extension-panel.ts`'s
  // `logUnavailable()`/`module-action-handler.ts`'s `logModuleActionFailed()` never-leak-
  // internal-detail discipline exactly.
  operationalLog(
    logger,
    'error',
    OperationalEvent.EXTENSION_MODULE_DATA_ROUTE_FAILED,
    'Extension module data route failed',
    { routeKey, subReason }
  )
}

/**
 * Story 29.4 AC5 — the single unit of work wrapped in `raceWithTimeout()`: invokes the module's
 * own handler and validates its returned shape. A throw, a timeout, or a malformed result all
 * map to the same `{ kind: 'failed' }` outcome — callers must never try to recover more detail
 * than the fixed `subReason` from a failed attempt (mirrors `extension-panel.ts`'s
 * `PanelAttemptOutcome` discipline). Exported so failure-degradation behavior can be unit-tested
 * directly, without going through a real HTTP request/timer wait for every subReason.
 */
export async function attemptModuleDataRoute(
  handler: ModuleDataRouteHandler,
  context: ModuleDataRequestContext,
  logger: ModuleDataLogger,
  routeKey: string,
  timeoutMs: number = MODULE_DATA_ROUTE_TIMEOUT_MS
): Promise<ModuleDataAttemptOutcome> {
  const raced = await raceWithTimeout(() => handler(context), timeoutMs)

  if (raced.status === 'timed_out') {
    logModuleDataRouteFailed(logger, routeKey, 'timed_out')
    return { kind: 'failed', subReason: 'timed_out' }
  }
  if (raced.status === 'rejected') {
    logModuleDataRouteFailed(logger, routeKey, 'threw')
    return { kind: 'failed', subReason: 'threw' }
  }
  if (isMalformedModuleDataResult(raced.value)) {
    logModuleDataRouteFailed(logger, routeKey, 'malformed_result')
    return { kind: 'failed', subReason: 'malformed_result' }
  }

  const result = raced.value as ModuleDataResult
  return { kind: 'ok', status: result.status ?? 200, body: result.body }
}

/** Story 29.4 AC5 — the fixed, non-leaking response for any degraded attempt outcome. */
const MODULE_DATA_UNAVAILABLE_BODY = {
  code: 'module_data_unavailable',
  message: 'This data is temporarily unavailable.',
} as const

/**
 * Story 29.4 AC3/AC9 — builds `ModuleDataRequestContext` from THIS request's own resolved
 * `secureCtx.auth`/`req.params`/`req.query`, never memoized, never read from a client-supplied
 * body/header — identical discipline to `resolveBaseModuleActionContext()`'s own existing
 * `identity`/`orgId` handling (extension-panel.ts).
 */
function buildModuleDataRequestContext(
  secureCtx: SecureRouteContext,
  req: FastifyRequest
): ModuleDataRequestContext {
  return {
    identity: { userId: secureCtx.auth.userId, orgRole: secureCtx.auth.orgRole },
    orgId: secureCtx.auth.orgId,
    params: req.params as Record<string, string>,
    query: req.query as Record<string, string>,
  }
}

/**
 * Story 29.4 AC4 — a Fastify plugin mounting one real route per `moduleDataRoutes` entry
 * declared by the currently loaded extension, reading `getExtensionStatus()` ONCE at
 * registration time (not per-request, unlike `extensionPanelRoutes`/`extensionStatusRoutes`) —
 * the route's very EXISTENCE is manifest-declared, so it must already be decided when this
 * plugin registers. `apps/api/src/app.ts` wires this in IMMEDIATELY AFTER `loadExtension()`
 * resolves (AC4's load-bearing ordering fact — every other extension-related route registers
 * BEFORE `loadExtension()` and re-checks `getExtensionStatus()` fresh inside each request
 * handler instead, since their own URL shapes never depend on what the extension declares).
 *
 * When no extension is loaded, or the loaded extension omits `moduleDataRoutes`, this plugin
 * mounts zero routes — `GET /api/v1/extensions/data/anything` 404s exactly like any other
 * nonexistent route, not a `503`/degraded-panel-style response (AC4's Edge/failure).
 */
export async function moduleDataRoutes(fastify: FastifyApp): Promise<void> {
  const status = getExtensionStatus()
  if (status.status !== 'loaded' || !status.manifest.moduleDataRoutes) return

  for (const route of status.manifest.moduleDataRoutes) {
    const routeKey = `${route.method} ${route.path}`
    // Defensive only — `registerExtension()`'s own AC3 callability check already guarantees
    // every declared route has a matching handler by the time an extension reaches 'loaded'.
    // eslint-disable-next-line security/detect-object-injection -- routeKey is derived from this same manifest's own moduleDataRoutes entries (method/path already charset-validated at registerExtension() time), never from request-supplied input.
    const handler = status.hooks.moduleData?.[routeKey]
    if (typeof handler !== 'function') continue

    secureRoute(fastify, {
      method: route.method,
      url: route.path,
      // AC4: the SAME auth middleware/session-resolution path every native PV route uses
      // (`request.authContext`, resolved from the session cookie) — no bespoke auth check
      // written for this mechanism. No explicit `rateLimit` override: `secureRoute()`'s own
      // default (60/min/route-key) applies, a deliberate choice (Dev Notes), not an oversight.
      security: { requireAuth: true, writeAuditEvent: false },
      handler: async (ctx, req: FastifyRequest, reply) => {
        const secureCtx = ctx as SecureRouteContext
        const context = buildModuleDataRequestContext(secureCtx, req)
        const outcome = await attemptModuleDataRoute(handler, context, req.log, routeKey)
        if (outcome.kind === 'failed') {
          return reply.status(502).send(MODULE_DATA_UNAVAILABLE_BODY)
        }
        return reply.status(outcome.status).send(outcome.body)
      },
    })
  }
}
