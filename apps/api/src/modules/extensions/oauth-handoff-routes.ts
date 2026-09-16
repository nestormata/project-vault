import { randomBytes, createHmac } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { extensionOauthPendingStates } from '@project-vault/db/schema'
import type {
  ActionResult,
  OAuthHandoffHooks,
  OAuthHandoffRedirectResult,
} from '@project-vault/extension-api'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { env } from '../../config/env.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { getExtensionStatus } from '../../extensions/loader.js'
import {
  defaultRenderExtensionPanelDeps,
  resolveBaseModuleActionContext,
  type PanelIdentity,
} from '../../lib/extension-panel.js'
import { raceWithTimeout } from '../../lib/race-with-timeout.js'
import { operationalLog } from '../../lib/logger.js'
import { OperationalEvent } from '@project-vault/shared'
import type { CookieReply } from '../auth/tokens.js'
import { CSRF_HEADER_NAME, isRejectedByCsrfToken } from '../../lib/csrf.js'
import { isRejectedBySecFetchSite } from '../../extensions/panel-routes.js'

/**
 * Story 39.1 — PV's own route layer for the `oauthHandoff` extension-api mechanism (Recommended
 * Mechanism Decision, option (a)-refined). PV owns ALL cookie cryptography and the actual HTTP
 * response — this file is the ONLY code that ever issues a real `302`/`Set-Cookie` for this
 * mechanism; the loaded extension's `onOAuthStart`/`onOAuthCallback` hooks only ever return plain
 * data. Modeled directly on `apps/api/src/modules/auth/handoff-routes.ts`'s existing
 * opaque-cookie + HMAC-hash + DB-backed pending-state + TTL pattern.
 */

const OAUTH_HANDOFF_COOKIE_NAME = 'oauth-handoff-pending'
const OAUTH_HANDOFF_COOKIE_PATH = '/api/v1/extensions/oauth-handoff'

// Pre-Mortem finding 1 — handoff-routes.ts's PENDING_TTL_MS (120s) was tuned for a same-page
// prepare->confirm flow with no external hop; this journey includes a real network round trip to
// a third-party provider's own consent screen, so 120s is too tight to copy verbatim. 8 minutes is
// the midpoint of the "5-10 minutes, matching typical OAuth `state` TTL conventions" range this
// story's Pre-Mortem calls for, with no further signal favoring either end of that range.
export const PENDING_TTL_MS = 8 * 60 * 1000

const HOOK_TIMEOUT_MS = 10_000

// Assumption Audit — "`state` is always small, JSON-serializable, and cheap to store": an explicit
// size cap, checked before insert, never a silent DB failure.
export const MAX_STATE_SIZE_BYTES = 4 * 1024

const GENERIC_REJECTION_MESSAGE = 'Request could not be verified. Please start again.'

function sendGenericRejection(reply: FastifyReply): unknown {
  return reply
    .status(401)
    .send({ code: 'oauth_handoff_rejected', message: GENERIC_REJECTION_MESSAGE })
}

function sendNotFound(reply: FastifyReply): unknown {
  return reply.status(404).send({ code: 'oauth_handoff_not_found', message: 'Not found' })
}

function generateOpaqueId(): string {
  return randomBytes(24).toString('base64url')
}

function hashCookieValue(raw: string): string {
  return createHmac('sha256', env.SSO_STATE_HMAC_SECRET).update(raw).digest('hex')
}

function readPendingCookie(request: FastifyRequest): string | undefined {
  const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies
  return cookies?.[OAUTH_HANDOFF_COOKIE_NAME]
}

/**
 * Story 39.1 AC2 — defense-in-depth for the callback leg, deliberately NOT
 * `handoff-routes.ts`'s `isRejectedByOriginChecks` (that check requires `Origin`'s host to equal
 * PV's own `Host` — correct for a same-origin confirm POST, but this callback is a legitimate
 * CROSS-SITE top-level navigation BACK from the external provider by construction, AC2's whole
 * point). Instead this only rejects a request whose `Sec-Fetch-Mode` is present and is NOT
 * `navigate` — i.e. a background `fetch()`/`XHR` attempt rather than a real top-level browser
 * navigation. A request missing the header entirely (older browsers) passes through, matching
 * this codebase's existing Fetch-Metadata-compatibility convention. The PRIMARY CSRF/replay
 * boundary is still the single-use, `SameSite=Lax` pending-state cookie itself (Recommended
 * Mechanism Decision) — this is a secondary layer only.
 */
function isRejectedByFetchMode(request: FastifyRequest): boolean {
  const header = request.headers['sec-fetch-mode']
  if (header === undefined) return false
  const value = Array.isArray(header) ? header[0] : header
  return value !== 'navigate'
}

type OAuthHandoffOutcome = OAuthHandoffRedirectResult | ActionResult

function isValidActionResult(value: unknown): value is ActionResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { outcome?: unknown; html?: unknown; message?: unknown }
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string'
  switch (candidate.outcome) {
    case 'ok':
      return optionalString(candidate.html) && optionalString(candidate.message)
    case 'validation_failed':
      return typeof candidate.message === 'string'
    case 'denied':
    case 'conflict':
      return optionalString(candidate.message)
    case 'error':
      return true
    default:
      return false
  }
}

// AC6 — extended for the new redirect variant, mirroring module-action-handler.ts's
// isValidActionResult() exactly for every other outcome.
function isValidOAuthHandoffOutcome(value: unknown): value is OAuthHandoffOutcome {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { outcome?: unknown; url?: unknown; state?: unknown }
  if (candidate.outcome === 'redirect') {
    return (
      typeof candidate.url === 'string' &&
      !!candidate.state &&
      typeof candidate.state === 'object' &&
      !Array.isArray(candidate.state)
    )
  }
  return isValidActionResult(value)
}

const FIXED_STATUS_BY_OUTCOME = {
  denied: { status: 403, code: 'denied', message: 'Request denied' },
  error: { status: 500, code: 'internal_error', message: 'Request failed' },
} as const

/**
 * Story 39.1 AC6 — maps a non-redirect `ActionResult` the same way
 * `apps/api/src/extensions/panel-routes.ts`'s `mapModuleActionOutcomeToResponse()` already maps
 * `ModuleAction.onAction()`'s outcomes — reused convention, not reinvented.
 */
function mapActionResultToResponse(result: ActionResult): {
  status: number
  body: Record<string, unknown>
} {
  if (result.outcome === 'ok') {
    return {
      status: 200,
      body: {
        ...(result.html !== undefined ? { html: result.html } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      },
    }
  }
  if (result.outcome === 'validation_failed') {
    return { status: 400, body: { code: 'validation_failed', message: result.message } }
  }
  if (result.outcome === 'conflict') {
    return { status: 409, body: { code: 'conflict', message: result.message ?? 'Conflict' } }
  }
  const fixed = FIXED_STATUS_BY_OUTCOME[result.outcome]
  return { status: fixed.status, body: { code: fixed.code, message: fixed.message } }
}

function logOAuthHandoffFailed(
  logger: { error: (payload: unknown) => void },
  leg: 'start' | 'callback',
  subReason: 'timed_out' | 'threw' | 'malformed' | 'invalid_redirect_origin' | 'state_too_large'
): void {
  operationalLog(
    logger as never,
    'error',
    OperationalEvent.EXTENSION_MODULE_ACTION_FAILED,
    'Extension OAuth handoff failed',
    { leg, subReason }
  )
}

/**
 * Story 39.1 AC9 — validates a `redirect` outcome's `url` before PV ever issues a real `302`:
 * must parse as an absolute URL, must be `https:` (Boundary Sweep: a non-`https` scheme is
 * rejected before ever reaching allow-list validation, never redirected to — `new URL()` also
 * naturally rejects a protocol-relative `//attacker.example` string, since no base URL is
 * supplied here), and its origin (scheme+host+port only, never path/query) must exactly match one
 * entry in the extension's own manifest-declared `redirectOrigins` allow-list — including the
 * very first redirect (the provider's own authorize URL), since even that is extension-supplied
 * data.
 */
function isAllowedRedirectUrl(url: string, allowOrigins: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  return allowOrigins.includes(parsed.origin)
}

type LoadedOAuthHandoffExtension = {
  name: string
  redirectOrigins: readonly string[]
  onOAuthStart: OAuthHandoffHooks['onOAuthStart']
  onOAuthCallback: OAuthHandoffHooks['onOAuthCallback']
}

/**
 * Story 39.1 AC7 — the ONLY place this mechanism is enforced: a currently-loaded extension whose
 * manifest declares `'oauth-handoff'` in `capabilities[]` AND whose `hooksFactory()` result
 * returned a callable `oauthHandoff` hook. Mirrors `module-action-handler.ts`'s
 * `getExtensionStatus()` re-check-fresh-every-request discipline exactly — never cached from an
 * earlier call, since the extension can genuinely be gone by request time.
 */
function loadOAuthHandoffExtension(): LoadedOAuthHandoffExtension | undefined {
  const status = getExtensionStatus()
  if (status.status !== 'loaded') return undefined
  if (!status.manifest.capabilities.includes('oauth-handoff')) return undefined
  const hook = status.hooks.oauthHandoff
  if (!hook) return undefined
  return {
    name: status.manifest.name,
    redirectOrigins: status.manifest.redirectOrigins ?? [],
    onOAuthStart: hook.onOAuthStart,
    onOAuthCallback: hook.onOAuthCallback,
  }
}

function stateByteLength(state: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(state), 'utf8')
}

function sendInternalError(reply: FastifyReply): unknown {
  return reply.status(500).send({ code: 'internal_error', message: 'Request failed' })
}

/**
 * Story 39.1 — shared by `handleStart`/`handleCallback`: races the hook call against the shared
 * timeout, maps a timeout/thrown-error/malformed-shape failure to the identical `500` response
 * both routes already used inline, and returns `undefined` once the response has been sent (so
 * the caller knows to stop) or the validated outcome to continue with. Extracted purely to keep
 * both callers' own cyclomatic complexity within this repo's lint budget — the three
 * timed_out/rejected/malformed branches were previously duplicated in each function.
 */
async function raceAndValidateOutcome(
  attempt: () => Promise<OAuthHandoffOutcome>,
  reply: FastifyReply,
  logger: { error: (payload: unknown) => void },
  leg: 'start' | 'callback'
): Promise<OAuthHandoffOutcome | undefined> {
  const raced = await raceWithTimeout(attempt, HOOK_TIMEOUT_MS)

  if (raced.status === 'timed_out') {
    logOAuthHandoffFailed(logger, leg, 'timed_out')
    sendInternalError(reply)
    return undefined
  }
  if (raced.status === 'rejected') {
    logOAuthHandoffFailed(logger, leg, 'threw')
    sendInternalError(reply)
    return undefined
  }
  if (!isValidOAuthHandoffOutcome(raced.value)) {
    logOAuthHandoffFailed(logger, leg, 'malformed')
    sendInternalError(reply)
    return undefined
  }
  return raced.value
}

async function issueRedirect(
  reply: FastifyReply,
  extension: Pick<LoadedOAuthHandoffExtension, 'redirectOrigins'>,
  leg: 'start' | 'callback',
  logger: { error: (payload: unknown) => void },
  result: OAuthHandoffRedirectResult
): Promise<unknown> {
  if (!isAllowedRedirectUrl(result.url, extension.redirectOrigins)) {
    logOAuthHandoffFailed(logger, leg, 'invalid_redirect_origin')
    return sendGenericRejection(reply)
  }
  return reply.status(302).header('Location', result.url).send()
}

// Mirrors `apps/api/src/extensions/panel-routes.ts`'s POST actions route defense-in-depth exactly
// — this is also an authenticated MUTATION surface an extension's own hook drives. Extracted to
// keep `handleStart`'s own cyclomatic complexity within this repo's lint budget. Returns the
// specific rejection reason (both map to a 403, but with distinct `code` values the client can
// tell apart) or `undefined` when neither guard rejects the request.
function rejectedStartSecurityGuardReason(
  request: FastifyRequest
): 'denied' | 'csrf_rejected' | undefined {
  if (isRejectedBySecFetchSite(request.headers['sec-fetch-site'])) return 'denied'
  // eslint-disable-next-line security/detect-object-injection -- CSRF_HEADER_NAME is a fixed, hardcoded string constant ('x-csrf-token'), never user input.
  if (
    isRejectedByCsrfToken(request.cookies, request.headers[CSRF_HEADER_NAME], env.COOKIE_SECURE)
  ) {
    return 'csrf_rejected'
  }
  return undefined
}

function parseStartBody(body: unknown): (Record<string, unknown> & { kind: string }) | undefined {
  const candidate = body as (Record<string, unknown> & { kind?: unknown }) | undefined
  if (!candidate || typeof candidate.kind !== 'string' || candidate.kind.length === 0) {
    return undefined
  }
  return candidate as Record<string, unknown> & { kind: string }
}

/**
 * Story 39.1 AC1/AC9/Assumption Audit — validates a `redirect` outcome's `url` (allow-list) and
 * `state` (size cap), then persists the pending-state row and issues the httpOnly cookie. Returns
 * `false` once a rejection response has already been sent, `true` when the caller should proceed
 * to `issueRedirect`. Extracted purely to keep `handleStart`'s own cyclomatic complexity within
 * this repo's lint budget.
 */
async function mintPendingStateAndCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  extension: LoadedOAuthHandoffExtension,
  result: OAuthHandoffRedirectResult
): Promise<boolean> {
  if (!isAllowedRedirectUrl(result.url, extension.redirectOrigins)) {
    logOAuthHandoffFailed(request.log, 'start', 'invalid_redirect_origin')
    sendGenericRejection(reply)
    return false
  }

  if (stateByteLength(result.state) > MAX_STATE_SIZE_BYTES) {
    logOAuthHandoffFailed(request.log, 'start', 'state_too_large')
    reply
      .status(400)
      .send({ code: 'oauth_handoff_state_too_large', message: 'state payload is too large' })
    return false
  }

  const rawCookie = randomBytes(32).toString('base64url')
  const cookieHash = hashCookieValue(rawCookie)
  const id = generateOpaqueId()
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS)

  try {
    await getDb()
      .insert(extensionOauthPendingStates)
      .values({
        id,
        cookieHash,
        extensionName: extension.name,
        stateJson: JSON.stringify(result.state),
        expiresAt,
      })
  } catch {
    reply
      .status(503)
      .send({ code: 'oauth_handoff_unavailable', message: 'OAuth handoff is unavailable' })
    return false
  }

  ;(reply as unknown as CookieReply).setCookie(OAUTH_HANDOFF_COOKIE_NAME, rawCookie, {
    httpOnly: true,
    // Recommended Mechanism Decision — `lax`, not `strict`: this cookie MUST survive the
    // top-level cross-site navigation to the external OAuth provider and back, per RFC 6265bis's
    // SameSite=Strict cross-site-navigation drop behavior. Matches `cookie-jar.ts`'s
    // REQUIRED_COOKIE_ATTRIBUTES this story's Exact Consumer Contract cites.
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: OAUTH_HANDOFF_COOKIE_PATH,
    maxAge: PENDING_TTL_MS / 1000,
  })
  return true
}

/**
 * Story 39.1 AC1 — `POST /api/v1/extensions/oauth-handoff/start`. Authenticated
 * (`requireAuth: true`, PV's normal in-app caller) — builds the same `ModuleActionContext` shape
 * every other in-app-authenticated hook call receives (`resolveBaseModuleActionContext`, reused
 * verbatim), then translates `onOAuthStart()`'s result into either a real `302` + `Set-Cookie` or
 * a passthrough `ActionResult` response (AC6).
 */
async function handleStart(
  ctx: SecureRouteContext,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const extension = loadOAuthHandoffExtension()
  if (!extension) return sendNotFound(reply)
  const guardReason = rejectedStartSecurityGuardReason(request)
  if (guardReason) {
    return reply.status(403).send({ code: guardReason, message: 'Request rejected' })
  }

  const body = parseStartBody(request.body)
  if (!body) {
    return reply.status(400).send({ code: 'invalid_request', message: 'Missing action kind' })
  }

  const identity: PanelIdentity = {
    userId: ctx.auth.userId,
    orgId: ctx.auth.orgId,
    orgRole: ctx.auth.orgRole,
  }
  const base = await resolveBaseModuleActionContext(
    'oauth-handoff',
    identity,
    ctx.tx,
    {},
    defaultRenderExtensionPanelDeps,
    undefined
  )
  // AC1: no projectId is ever supplied on this route, so `resolveBaseModuleActionContext` can
  // only ever resolve `{kind: 'ok'}` here — this branch exists purely to satisfy its return type.
  if (base.kind === 'denied') return sendNotFound(reply)

  const result = await raceAndValidateOutcome(
    () => extension.onOAuthStart(base.context, { action: body }),
    reply,
    request.log,
    'start'
  )
  if (!result) return reply

  if (result.outcome !== 'redirect') {
    const mapped = mapActionResultToResponse(result)
    return reply.status(mapped.status).send(mapped.body)
  }

  if (!(await mintPendingStateAndCookie(reply, request, extension, result))) return reply

  return issueRedirect(reply, extension, 'start', request.log, result)
}

type PendingRow = typeof extensionOauthPendingStates.$inferSelect

/**
 * Story 39.1 AC3 — single-use burn-before-use as ONE atomic conditional `UPDATE ... RETURNING`:
 * at most one concurrent caller can ever see a non-empty result for a given `cookieHash`
 * (Boundary Sweep's concurrent-duplicate-callback-hits requirement). `expiresAt` comparison uses
 * the database's own `now()`, never app-process wall-clock time (Pre-Mortem finding 2).
 */
async function burnPendingState(cookieHash: string): Promise<PendingRow | undefined> {
  const rows = await getDb()
    .update(extensionOauthPendingStates)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(extensionOauthPendingStates.cookieHash, cookieHash),
        sql`${extensionOauthPendingStates.consumedAt} IS NULL`,
        sql`${extensionOauthPendingStates.expiresAt} > now()`
      )
    )
    .returning()
  return rows[0]
}

/**
 * Story 39.1 AC2/AC3 — `GET /api/v1/extensions/oauth-handoff/callback`. Public
 * (`requireAuth: false`) — hit directly by the external OAuth provider, never by PV's own
 * authenticated frontend. Resolves the pending cookie, burns it before any hook is ever invoked,
 * re-checks the originating extension is still loaded/capable (Assumption Audit), then invokes
 * `onOAuthCallback()` with the recovered `state` and the provider's raw query params.
 */
type ResolvedCallbackPending = {
  extension: LoadedOAuthHandoffExtension
  state: Record<string, unknown>
}

function parsePendingStateJson(stateJson: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stateJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Story 39.1 AC2/AC3/Assumption Audit — resolves the pending cookie (burn-before-use), re-checks
 * the originating extension is still loaded/capable, and parses its stored `state`. Returns
 * `undefined` for every failure mode (missing/expired/replayed cookie, extension gone/swapped,
 * corrupt state) — all collapse to the SAME generic rejection at the call site (AC3), never
 * distinguished. Extracted purely to keep `handleCallback`'s own cyclomatic complexity within this
 * repo's lint budget.
 */
async function resolveCallbackPending(
  request: FastifyRequest
): Promise<ResolvedCallbackPending | undefined> {
  const rawCookie = readPendingCookie(request)
  if (!rawCookie) return undefined

  const pending = await burnPendingState(hashCookieValue(rawCookie))
  if (!pending) return undefined

  const extension = loadOAuthHandoffExtension()
  if (!extension || extension.name !== pending.extensionName) return undefined

  const state = parsePendingStateJson(pending.stateJson)
  if (!state) return undefined

  return { extension, state }
}

function callbackQueryParams(request: FastifyRequest): Record<string, string> {
  if (!request.query || typeof request.query !== 'object') return {}
  return Object.fromEntries(
    Object.entries(request.query as Record<string, unknown>).map(([key, value]) => [
      key,
      Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''),
    ])
  )
}

async function handleCallback(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  // AC2: defense-in-depth only — never the primary CSRF/replay boundary (that's the single-use,
  // SameSite=Lax pending-state cookie itself).
  if (isRejectedByFetchMode(request)) return sendGenericRejection(reply)

  const resolved = await resolveCallbackPending(request)
  // AC3: every resolution failure (missing/expired/replayed cookie, extension gone/swapped,
  // corrupt state) collapses to the identical generic rejection; onOAuthCallback() is never
  // invoked in any of these cases.
  if (!resolved) return sendGenericRejection(reply)
  const { extension, state } = resolved

  const result = await raceAndValidateOutcome(
    () => extension.onOAuthCallback(callbackQueryParams(request), state),
    reply,
    request.log,
    'callback'
  )
  if (!result) return reply

  if (result.outcome !== 'redirect') {
    const mapped = mapActionResultToResponse(result)
    return reply.status(mapped.status).send(mapped.body)
  }

  return issueRedirect(reply, extension, 'callback', request.log, result)
}

export async function oauthHandoffRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/start',
    bodyLimit: 16 * 1024,
    security: {
      requireAuth: true,
      writeAuditEvent: false,
      rateLimit: { max: 30, timeWindowMs: 60_000 },
    },
    handler: (ctx, request, reply) => handleStart(ctx as SecureRouteContext, request, reply),
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/callback',
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /callback' },
    },
    handler: (_ctx, request, reply) => handleCallback(request, reply),
  })
}
