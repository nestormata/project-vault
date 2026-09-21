import type { FastifyReply, FastifyRequest } from 'fastify'
import type {
  ActionResult,
  PublicRouteHooks,
  PublicRouteRequest,
  PublicRouteResult,
} from '@project-vault/extension-api'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute } from '../../lib/secure-route.js'
import { normalizeQueryParams } from '../../lib/route-helpers.js'
import { raceWithTimeout } from '../../lib/race-with-timeout.js'
import { operationalLog } from '../../lib/logger.js'
import { isValidActionResult, mapActionResultToResponse } from '../../lib/action-result-response.js'
import { getExtensionStatus } from '../../extensions/loader.js'

/**
 * Story 20.13 — PV's own route layer for the `publicRoute` extension-api mechanism (Design
 * Decision B: each declared `anonymousRoutePaths` template is registered as a REAL Fastify route
 * at extension-load time, reusing `find-my-way`'s own literal-beats-`:param` precedence — no
 * bespoke matcher). Mirrors `extensions/module-data-routes.ts`'s own "read `getExtensionStatus()`
 * ONCE at registration time, mount one real route per manifest-declared entry" pattern (Story
 * 29.4 AC4's precedent for a manifest-declared route *existence*), combined with
 * `oauth-handoff-routes.ts`'s timeout/error-mapping/generic-rejection conventions (AC5).
 *
 * `apps/api/src/app.ts` MUST register this plugin AFTER `loadExtension()` resolves, exactly like
 * `moduleDataRoutes` — the route's very EXISTENCE (which URLs respond at all) is manifest-declared,
 * so an undeclared path never reaches a registered handler at all (AC3), and simply 404s via
 * Fastify's own default not-found handling — no bespoke "is this path allow-listed" check needed
 * at request time, the allow-list IS which routes got registered.
 */

const HOOK_TIMEOUT_MS = 10_000

type PublicRouteOutcome = PublicRouteResult | ActionResult

// Code review fix (Medium finding #1) — a valid-shaped-but-out-of-range `status`, or a header
// value smuggling a CRLF/control character, would previously reach `reply.status(...).send(...)`/
// `reply.header(...)` unvalidated and throw past this route's own `raceWithTimeout` try/catch,
// landing in `app.ts`'s app-wide `setErrorHandler` instead of this route's own
// `sendInternalError`/`logPublicRouteFailed` path. Not a confirmed leak (the app-wide handler
// already falls back to the same generic 500 shape), but it silently skipped this route's own
// `EXTENSION_PUBLIC_ROUTE_FAILED` operational logging for that failure mode. Validating here makes
// AC5's "generic 500, always logged" guarantee structurally true rather than incidentally true.
const MIN_HTTP_STATUS = 100
const MAX_HTTP_STATUS = 599
// Code review fix (High finding) — `PublicRouteResult`'s own doc comment states "there is no
// redirect outcome in v1" (closing the SSRF-proxy/cache-poisoning angle from this story's Red
// Team vs Blue Team elicitation round), but nothing previously enforced that: a hook could return
// `{ outcome: 'response', status: 302, headers: { location: '...' } }` and it would have passed
// straight through to `reply.status(outcome.status).send(...)`. Rejecting the whole 3xx range here
// makes the documented v1 restriction structurally true instead of merely documented.
const REDIRECT_STATUS_MIN = 300
const REDIRECT_STATUS_MAX = 399
const HEADER_VALUE_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/

function isValidPublicRouteHeaders(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === 'string' && !HEADER_VALUE_CONTROL_CHAR_PATTERN.test(v)
  )
}

/**
 * Story 20.13 AC4 — validates the hook's returned shape: either a `{ outcome: 'response', status:
 * number, ... }` instruction, or the existing `ActionResult` union (`isValidActionResult()` reused
 * unchanged), exactly mirroring `oauth-handoff-routes.ts`'s `isValidOAuthHandoffOutcome()`'s own
 * extension pattern for its own new outcome variant. `status` must be a real HTTP status code and
 * `headers` (if present) must be CRLF/control-char-free strings only — both checked here so a
 * malformed hook response is caught by this route's own generic-rejection path (AC5), never left to
 * throw past it.
 */
function isValidPublicRouteOutcome(value: unknown): value is PublicRouteOutcome {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { outcome?: unknown; status?: unknown; headers?: unknown }
  if (candidate.outcome === 'response') {
    return (
      typeof candidate.status === 'number' &&
      Number.isInteger(candidate.status) &&
      candidate.status >= MIN_HTTP_STATUS &&
      candidate.status <= MAX_HTTP_STATUS &&
      !(candidate.status >= REDIRECT_STATUS_MIN && candidate.status <= REDIRECT_STATUS_MAX) &&
      isValidPublicRouteHeaders(candidate.headers)
    )
  }
  return isValidActionResult(value)
}

/**
 * Code review fix (High finding) — this body shape now exactly mirrors Fastify's own default
 * not-found response (`{ message: "Route <METHOD>:<url> not found", error: 'Not Found',
 * statusCode: 404 }`, verified against a live Fastify instance) instead of a bespoke
 * `{ code, message }` shape. Every in-handler denial (Sec-Fetch-Mode rejection, capability
 * withdrawn, hook missing, path no longer allow-listed) previously returned a body
 * distinguishable from Fastify's generic 404 for a genuinely undeclared path — giving an
 * anonymous caller an oracle to fingerprint an extension's declared `anonymousRoutePaths`
 * surface (and whether it's currently denied vs. never declared) purely from response shape,
 * even though both cases already shared the same 404 status code. AC5's "non-enumerating"
 * guarantee applies to the body, not just the status code — this closes that gap.
 */
function sendNotFound(reply: FastifyReply, request: FastifyRequest): unknown {
  return reply.status(404).send({
    message: `Route ${request.method}:${request.url} not found`,
    error: 'Not Found',
    statusCode: 404,
  })
}

function sendInternalError(reply: FastifyReply): unknown {
  return reply.status(500).send({ code: 'internal_error', message: 'Request failed' })
}

/**
 * Story 20.13 AC5 — the same `Sec-Fetch-Mode` defense-in-depth check `oauth-handoff-routes.ts`'s
 * own `isRejectedByFetchMode()` implements (that function is not exported from its own module, so
 * this is a deliberate small local duplicate — mirrors this codebase's existing precedent of
 * locally duplicating a small, stable helper/constant rather than exporting a one-off from an
 * unrelated route file, e.g. `module-data-routes.ts`'s own `MODULE_DATA_ROUTE_TIMEOUT_MS` doc
 * comment). This route is GET-navigable only (Design Decision C), so the check applies
 * unconditionally.
 */
function isRejectedByFetchMode(request: FastifyRequest): boolean {
  const header = request.headers['sec-fetch-mode']
  if (header === undefined) return false
  const value = Array.isArray(header) ? header[0] : header
  return value !== 'navigate'
}

/**
 * Story 20.13 AC2 — the ONLY place this mechanism's authorization is re-checked: a currently-
 * loaded extension whose manifest still declares `'public-route'` in `capabilities[]`, whose
 * `anonymousRoutePaths` allow-list still contains `pathTemplate`, AND whose `hooksFactory()`
 * result still has a callable `publicRoute.onPublicRouteRequest` hook. Mirrors
 * `oauth-handoff-routes.ts`'s `loadOAuthHandoffExtension()` re-check-fresh-every-request
 * discipline exactly — never cached from route-registration time (`publicRouteRoutes()` only
 * reads `getExtensionStatus()` once to decide which URLs exist at all; this function re-derives
 * the actual authorization decision fresh on every single request).
 */
function loadPublicRouteHookFresh(
  pathTemplate: string
): PublicRouteHooks['onPublicRouteRequest'] | undefined {
  const status = getExtensionStatus()
  if (status.status !== 'loaded') return undefined
  if (!status.manifest.capabilities.includes('public-route')) return undefined
  if (!status.manifest.anonymousRoutePaths?.includes(pathTemplate)) return undefined
  const hook = status.hooks.publicRoute
  if (!hook || typeof hook.onPublicRouteRequest !== 'function') return undefined
  return hook.onPublicRouteRequest
}

function logPublicRouteFailed(
  logger: { error: (payload: unknown) => void },
  pathTemplate: string,
  subReason: 'timed_out' | 'threw' | 'malformed'
): void {
  operationalLog(
    logger as never,
    'error',
    OperationalEvent.EXTENSION_PUBLIC_ROUTE_FAILED,
    'Extension public route request failed',
    { pathTemplate, subReason }
  )
}

/**
 * Story 20.13 AC4 — the response-header allow-list translation: `Set-Cookie` is unconditionally
 * stripped from any extension-supplied headers (this anonymous path has no session concept to
 * write a cookie into), and PV applies NO default/shared HTTP cache headers of its own — only
 * cache headers the extension explicitly sets here ever reach the response (Security Audit
 * finding, Round 2).
 */
function applyPublicRouteHeaders(
  reply: FastifyReply,
  headers: Record<string, string> | undefined
): void {
  if (!headers) return
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'set-cookie') continue
    reply.header(name, value)
  }
}

/**
 * Story 20.13 AC1/AC3/AC4/AC5/AC5b — a Fastify plugin mounting one real GET route per
 * `anonymousRoutePaths` entry declared by the currently loaded extension, reading
 * `getExtensionStatus()` ONCE at registration time (not per-request, mirroring
 * `moduleDataRoutes`'s own precedent exactly — the route's very EXISTENCE is manifest-declared).
 * When no extension is loaded, the loaded extension omits the `'public-route'` capability, or its
 * `hooksFactory()` result has no callable `publicRoute` hook, this plugin mounts zero routes — any
 * request to a would-be path 404s exactly like any other nonexistent route, never a distinguishable
 * error revealing *why* (AC5's non-enumerating collapse).
 */
export async function publicRouteRoutes(fastify: FastifyApp): Promise<void> {
  const status = getExtensionStatus()
  if (status.status !== 'loaded') return
  if (!status.manifest.capabilities.includes('public-route')) return
  if (typeof status.hooks.publicRoute?.onPublicRouteRequest !== 'function') return
  const pathTemplates = status.manifest.anonymousRoutePaths ?? []

  for (const pathTemplate of pathTemplates) {
    secureRoute(fastify, {
      method: 'GET',
      url: pathTemplate,
      security: {
        requireAuth: false,
        writeAuditEvent: false,
        // AC5b: an IP-scoped rate limit mirroring `external-access-routes.ts`'s existing pattern,
        // scoped PER declared path template via `key` — one extension's heavily-hit route cannot
        // exhaust budget for a different declared template. `secureRoute()`'s own unauthenticated
        // rate-limit path already keys by `ip:${request.ip}` + this `key` (see
        // `secure-route.ts`), so this reuses the existing IP-scoping mechanism unchanged.
        rateLimit: { max: 60, timeWindowMs: 60_000, key: `GET ${pathTemplate}` },
      },
      handler: async (_ctx, request: FastifyRequest, reply: FastifyReply) => {
        // AC5: defense-in-depth only — never the primary boundary for this stateless mechanism.
        if (isRejectedByFetchMode(request)) return sendNotFound(reply, request)

        // AC2: re-checked fresh on every request, never cached from route-registration time.
        const onPublicRouteRequest = loadPublicRouteHookFresh(pathTemplate)
        if (!onPublicRouteRequest) return sendNotFound(reply, request)

        const publicRequest: PublicRouteRequest = {
          method: 'GET',
          pathTemplate,
          params: request.params as Record<string, string>,
          query: normalizeQueryParams(request),
        }

        const raced = await raceWithTimeout(
          () => onPublicRouteRequest(publicRequest),
          HOOK_TIMEOUT_MS
        )

        if (raced.status === 'timed_out') {
          logPublicRouteFailed(request.log, pathTemplate, 'timed_out')
          return sendInternalError(reply)
        }
        if (raced.status === 'rejected') {
          logPublicRouteFailed(request.log, pathTemplate, 'threw')
          return sendInternalError(reply)
        }
        if (!isValidPublicRouteOutcome(raced.value)) {
          logPublicRouteFailed(request.log, pathTemplate, 'malformed')
          return sendInternalError(reply)
        }

        const outcome = raced.value
        if (outcome.outcome !== 'response') {
          const mapped = mapActionResultToResponse(outcome)
          return reply.status(mapped.status).send(mapped.body)
        }

        applyPublicRouteHeaders(reply, outcome.headers)
        return reply.status(outcome.status).send(outcome.body)
      },
    })
  }
}
