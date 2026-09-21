import type { FastifyReply, FastifyRequest } from 'fastify'
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
import { normalizeQueryParams } from '../../lib/route-helpers.js'
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
import {
  burnPendingStateRow,
  generateOpaqueId,
  hashCookieValue,
  mintOpaqueCookieValue,
  parsePendingStateJson,
  ttlExpiresAtSql,
  validatePendingStateSize,
  type PendingStateRow,
} from '../../lib/extension-pending-state.js'
import { mintRequestStateAndCookie } from '../../lib/extension-request-state.js'
import { isValidActionResult, mapActionResultToResponse } from '../../lib/action-result-response.js'

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

// AC6 — extended for the new redirect variant, reusing the shared `isValidActionResult()`
// (`lib/action-result-response.ts`) exactly for every other outcome.
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
  return parseAllowedRedirectUrl(url, allowOrigins) !== undefined
}

/**
 * Code-review fix (39.1) — returns the *parsed* URL so callers can build the `Location` header
 * from its canonicalized `.href` rather than the raw, extension-supplied string. `new URL()`
 * strips ASCII tab/CR/LF from the string it parses, but does NOT mutate the original string — so
 * validating with `new URL(url)` and then still sending the original `url` verbatim would let a
 * CR/LF sequence that survives origin/protocol validation reach `reply.header('Location', ...)`
 * unchanged. Node's HTTP layer happens to reject invalid header characters today, but that's an
 * incidental property of the runtime, not something this code should depend on for a documented
 * security boundary (AC9).
 */
function parseAllowedRedirectUrl(url: string, allowOrigins: readonly string[]): URL | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  if (!allowOrigins.includes(parsed.origin)) return undefined
  return parsed
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
  const parsed = parseAllowedRedirectUrl(result.url, extension.redirectOrigins)
  if (!parsed) {
    logOAuthHandoffFailed(logger, leg, 'invalid_redirect_origin')
    return sendGenericRejection(reply)
  }
  // Code-review fix (39.1) — use the parsed/canonicalized URL, never the raw extension-supplied
  // string, so a control character (e.g. CR/LF) that survives validation can never reach the
  // response header.
  return reply.status(302).header('Location', parsed.href).send()
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
  result: OAuthHandoffRedirectResult,
  identity: PanelIdentity
): Promise<boolean> {
  if (!isAllowedRedirectUrl(result.url, extension.redirectOrigins)) {
    logOAuthHandoffFailed(request.log, 'start', 'invalid_redirect_origin')
    sendGenericRejection(reply)
    return false
  }

  const validation = validatePendingStateSize(result.state, MAX_STATE_SIZE_BYTES)
  if (!validation.ok) {
    logOAuthHandoffFailed(request.log, 'start', 'state_too_large')
    reply
      .status(400)
      .send({ code: 'oauth_handoff_state_too_large', message: 'state payload is too large' })
    return false
  }

  const rawCookie = mintOpaqueCookieValue()
  const cookieHash = hashCookieValue(rawCookie)
  const id = generateOpaqueId()

  try {
    await getDb()
      .insert(extensionOauthPendingStates)
      .values({
        id,
        cookieHash,
        extensionName: extension.name,
        // Story 40.1 — nullable metadata threaded through to the callback leg (see
        // `extension-oauth-pending-states.ts`'s own doc comment) so it can mint this story's
        // `extension_request_states` row (AC12's org/identity scoping) without needing its own
        // (nonexistent) PV session.
        orgId: identity.orgId,
        identityId: identity.userId,
        stateJson: JSON.stringify(result.state),
        // Code-review fix (39.1, Pre-Mortem finding 2) / Story 40.1 AC11 — computed by Postgres's
        // own `now()`, not the API process's `Date.now()`, via the shared
        // `extension-pending-state.ts` helper now reused by both this table and
        // `extension_request_states`. `burnPendingStateRow`'s read-side comparison already uses
        // the DB clock exclusively; computing the write-side value with the API's wall clock
        // would still let multi-host clock drift make the effective TTL longer or shorter than
        // intended. This keeps both the write and the read on the identical DB-side clock.
        expiresAt: ttlExpiresAtSql(PENDING_TTL_MS),
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

  if (!(await mintPendingStateAndCookie(reply, request, extension, result, identity))) return reply

  return issueRedirect(reply, extension, 'start', request.log, result)
}

/**
 * Story 39.1 AC3 / Story 40.1 AC11 — single-use burn-before-use as ONE atomic conditional
 * `UPDATE ... RETURNING`: at most one concurrent caller can ever see a non-empty result for a
 * given `cookieHash` (Boundary Sweep's concurrent-duplicate-callback-hits requirement).
 * `expiresAt` comparison uses the database's own `now()`, never app-process wall-clock time
 * (Pre-Mortem finding 2). Now backed by the shared `burnPendingStateRow()` helper
 * (`lib/extension-pending-state.ts`), reused verbatim by this story's own
 * `extension_request_states` consume path (AC11 rule-of-three extraction).
 */
async function burnPendingState(cookieHash: string): Promise<PendingStateRow | undefined> {
  return burnPendingStateRow('extension_oauth_pending_states', cookieHash)
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
  /** Story 40.1 — the START leg's authenticated caller identity, threaded through the burned
   * row's nullable `org_id`/`identity_id` columns (see `extension-oauth-pending-states.ts`).
   * `undefined` for a pending row minted before this story shipped, or in the (currently
   * unreachable, since `handleStart` always supplies both) theoretical case either is absent —
   * `mintRequestStateAndCookie()` is simply never attempted in that case (AC6's own
   * malformed-persist-leg-must-not-break-the-redirect discipline, generalized). */
  identity: { orgId: string; userId: string } | undefined
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
  if (extension?.name !== pending.extension_name) return undefined

  const state = parsePendingStateJson(pending.state_json)
  if (!state) return undefined

  // Story 40.1 — org_id (uuid)/identity_id (uuid) are stored as plain text columns; a row minted
  // before this story shipped left both NULL. Treated as `undefined` uniformly rather than
  // distinguishing "old row" from "somehow missing" — see `ResolvedCallbackPending`'s own doc
  // comment.
  const orgId = pending.org_id as string | null
  const identityId = pending.identity_id as string | null
  const identity = orgId && identityId ? { orgId, userId: identityId } : undefined

  return { extension, state, identity }
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
  const { extension, state, identity } = resolved

  const result = await raceAndValidateOutcome(
    () => extension.onOAuthCallback(normalizeQueryParams(request), state),
    reply,
    request.log,
    'callback'
  )
  if (!result) return reply

  if (result.outcome !== 'redirect') {
    const mapped = mapActionResultToResponse(result)
    return reply.status(mapped.status).send(mapped.body)
  }

  // Story 40.1 AC1/AC5/AC6/Pre-Mortem 3 — `persistState` is ONLY ever processed on the callback
  // leg's `redirect` outcome (AC5: a `persistState` on `onOAuthStart()`'s own result is handled
  // by `mintPendingStateAndCookie()` above, which never reads it at all — `OAuthHandoffRedirectResult`
  // is a shared type but only the callback call site below ever inspects this field). Pre-Mortem
  // 3's ordering requirement: the redirect `url`'s own allow-list validation
  // (`issueRedirect`/`parseAllowedRedirectUrl`) MUST run and succeed before `persistState` is ever
  // minted, so a rejected redirect never leaves an orphaned `extension_request_states` row behind.
  if (
    result.persistState &&
    identity &&
    isAllowedRedirectUrl(result.url, extension.redirectOrigins)
  ) {
    const mintOutcome = await mintRequestStateAndCookie(reply, {
      extensionName: extension.name,
      orgId: identity.orgId,
      identityId: identity.userId,
      persistState: result.persistState,
    })
    // AC6: a malformed/oversized persistState or a transient store failure is logged server-side
    // only and never blocks the outer redirect, which is governed independently by `url`/`state`.
    if (!mintOutcome.ok) {
      logOAuthHandoffFailed(
        request.log,
        'callback',
        mintOutcome.reason === 'too_large' ? 'state_too_large' : 'threw'
      )
    }
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
