import type { FastifyReply, FastifyRequest } from 'fastify'
import { getDb } from '@project-vault/db'
import { extensionRequestStates } from '@project-vault/db/schema'
import { sql } from 'drizzle-orm'
import { env } from '../config/env.js'
import type { CookieReply } from '../modules/auth/tokens.js'
import {
  burnPendingStateRow,
  generateOpaqueId,
  hashCookieValue,
  mintOpaqueCookieValue,
  parsePendingStateJson,
  peekPendingStateRow,
  ttlExpiresAtSql,
  validatePendingStateSize,
  type PendingStateRow,
} from './extension-pending-state.js'

/**
 * Story 40.1 — mint/peek/consume for the `extension_request_states` table backing
 * `OAuthHandoffRedirectResult.persistState` (mint, AC1), `ModuleActionContext.requestState`
 * (peek, AC2), and `HostServices.extensionRequestState.consume()` (consume, AC3/AC12). See
 * `packages/db/src/schema/extension-request-states.ts` for the full schema rationale and
 * `lib/extension-pending-state.ts` for the shared mint/hash/burn/TTL-compare primitives this
 * module reuses (AC11 rule-of-three extraction).
 */

export const REQUEST_STATE_COOKIE_NAME = 'extension-request-state'
// Open Design Question 5 — broader than 39.1's own `/api/v1/extensions/oauth-handoff` path: this
// cookie is minted by the oauth-handoff callback route but READ by the moduleAction/panel routes
// under `/api/v1/extensions`, so its path must cover both.
export const REQUEST_STATE_COOKIE_PATH = '/api/v1/extensions'
const TABLE_NAME = 'extension_request_states' as const

// Open Design Question 4 — 30 minutes: long enough for a user to browse a selection list (unlike
// 39.1's 8-minute OAuth-round-trip window, which is bounded by an external provider's own
// timeout expectations), short enough to remain a bounded, expiring grant rather than an
// effectively-permanent one. No existing PV session-idle-timeout convention was found in
// `apps/api/src/config/env.ts` to align with instead (session idle timeout there is measured in
// hours, a different order of magnitude for a different purpose), so this is a fresh, explicit,
// generous default per the story's own Pre-Mortem discussion.
export const REQUEST_STATE_TTL_MS = 30 * 60 * 1000

export const MAX_PERSIST_STATE_SIZE_BYTES = 4 * 1024

export type MintRequestStateInput = {
  extensionName: string
  orgId: string
  identityId: string
  persistState: Record<string, unknown>
}

export type MintRequestStateOutcome =
  { ok: true } | { ok: false; reason: 'too_large' | 'not_serializable' | 'store_unavailable' }

/**
 * Story 40.1 AC1/AC6/Pre-Mortem 3 — mints the second, longer-lived cookie + `extension_request_
 * states` row. Called ONLY from the callback leg's redirect path, and ONLY after the redirect
 * `url`'s own allow-list validation has already succeeded (Pre-Mortem 3's ordering requirement —
 * a rejected redirect must never leave an orphaned row behind). A validation failure here
 * (oversized/non-serializable payload, or a transient store failure) never blocks the outer
 * redirect — the caller logs the sub-reason and proceeds to `issueRedirect` regardless (AC6).
 */
export async function mintRequestStateAndCookie(
  reply: FastifyReply,
  input: MintRequestStateInput
): Promise<MintRequestStateOutcome> {
  const validation = validatePendingStateSize(input.persistState, MAX_PERSIST_STATE_SIZE_BYTES)
  if (!validation.ok) return { ok: false, reason: validation.reason }

  const rawCookie = mintOpaqueCookieValue()
  const cookieHash = hashCookieValue(rawCookie)
  const id = generateOpaqueId()

  try {
    await getDb()
      .insert(extensionRequestStates)
      .values({
        id,
        cookieHash,
        extensionName: input.extensionName,
        orgId: input.orgId,
        identityId: input.identityId,
        stateJson: JSON.stringify(input.persistState),
        expiresAt: ttlExpiresAtSql(REQUEST_STATE_TTL_MS),
      })
  } catch {
    return { ok: false, reason: 'store_unavailable' }
  }

  ;(reply as unknown as CookieReply).setCookie(REQUEST_STATE_COOKIE_NAME, rawCookie, {
    httpOnly: true,
    // AC1 — same `sameSite: 'lax'` choice as 39.1's own `oauth-handoff-pending` cookie: this
    // cookie is minted as part of the callback's own cross-site-navigation redirect response, so
    // it must survive that navigation, then be sent on the caller's later, ordinary same-site
    // moduleAction requests.
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    path: REQUEST_STATE_COOKIE_PATH,
    maxAge: REQUEST_STATE_TTL_MS / 1000,
  })
  return { ok: true }
}

function readRequestStateCookie(request: FastifyRequest): string | undefined {
  const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies
  return cookies?.[REQUEST_STATE_COOKIE_NAME]
}

/** AC12 — both peek and consume filter by `cookie_hash` AND `org_id`/`identity_id` matching the
 * CURRENT request's `ModuleActionContext`, so a hash match against a row minted under a
 * different org/identity resolves to `undefined`. Also re-checks `extension_name` matches the
 * CURRENTLY loaded extension (Boundary Sweep — extension disabled/uninstalled mid-journey fails
 * closed rather than leaking another/former extension's state). */
function scopedCondition(extensionName: string, orgId: string, identityId: string) {
  return sql`extension_name = ${extensionName} AND org_id = ${orgId} AND identity_id = ${identityId}`
}

function stateFromRow(row: PendingStateRow | undefined): Record<string, unknown> | undefined {
  if (!row) return undefined
  return parsePendingStateJson(row.state_json)
}

export type RequestStateScope = { extensionName: string; orgId: string; identityId: string }

/**
 * Story 40.1 AC2/AC4/AC8/AC12 — non-destructive, repeatable peek, used to populate
 * `ModuleActionContext.requestState`. Returns `undefined` for every failure mode (no cookie, no
 * matching row, expired, already consumed, extension/org/identity mismatch) — all collapsed
 * identically (AC4), never distinguished to the caller. Takes the raw cookie value directly
 * (rather than a `FastifyRequest`) so callers that have already extracted it (e.g.
 * `module-action-handler.ts`, which only populates this on the `moduleAction` path, never
 * `uiPanel` — AC8) don't need to thread a whole request object through.
 */
export async function peekRequestState(
  rawCookie: string | undefined,
  scope: RequestStateScope
): Promise<Record<string, unknown> | undefined> {
  if (!rawCookie) return undefined
  const row = await peekPendingStateRow(
    TABLE_NAME,
    hashCookieValue(rawCookie),
    scopedCondition(scope.extensionName, scope.orgId, scope.identityId)
  )
  return stateFromRow(row)
}

/**
 * Story 40.1 AC3/AC4/AC12 — atomic single-use burn, used by
 * `HostServices.extensionRequestState.consume()`. A cross-org/cross-identity attempt against a
 * real, unexpired, unconsumed row resolves to `undefined` AND does not burn the row (the `AND`
 * conditions are part of the same atomic `UPDATE`'s `WHERE`, so a non-matching scope simply never
 * matches any row to update).
 */
export async function consumeRequestState(
  rawCookie: string | undefined,
  scope: RequestStateScope
): Promise<Record<string, unknown> | undefined> {
  if (!rawCookie) return undefined
  const row = await burnPendingStateRow(
    TABLE_NAME,
    hashCookieValue(rawCookie),
    scopedCondition(scope.extensionName, scope.orgId, scope.identityId)
  )
  return stateFromRow(row)
}

export { readRequestStateCookie }
