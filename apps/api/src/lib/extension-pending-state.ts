import { randomBytes } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '@project-vault/db'

export { generateOpaqueId, hashCookieValue } from './opaque-cookie-token.js'

/**
 * Story 40.1 AC11 — shared mint/hash/burn/TTL-compare primitives for PV's "opaque cookie + HMAC
 * hash + DB-backed pending state + TTL" family of tables. This is the rule-of-three extraction
 * the Recommended Mechanism Decision's own ADR-style consequence commits to: 39.1's
 * `extension_oauth_pending_states` (via `oauth-handoff-routes.ts`, refactored onto this module)
 * and this story's `extension_request_states` (via `extension-request-state.ts`) are the third
 * and now-shared consumers of the identical mint/hash/burn/TTL-compare shape
 * `apps/api/src/modules/auth/handoff-routes.ts`'s `handoffPendingStates` established first. This
 * module covers the STORAGE/crypto layer only — it deliberately does NOT attempt to unify
 * `handoffPendingStates`' auth-handoff-specific row shape (WorkOS claim fields) with these two
 * extension-scoped tables' generic `state_json` shape (see this story's Dev Notes); refactoring
 * `handoff-routes.ts` itself onto this module is explicitly OUT of this story's scope.
 */

export function mintOpaqueCookieValue(): string {
  return randomBytes(32).toString('base64url')
}

/** Story 39.1 Assumption Audit / this story's Recommended Mechanism Decision #1 — the same size
 * cap check both `state` (39.1) and `persistState` (this story) are held to before insert. */
export type PendingStateValidation =
  { ok: true } | { ok: false; reason: 'too_large' | 'not_serializable' }

/**
 * Boundary & Edge Case Sweep — a `persistState`/`state` payload containing a non-JSON-
 * serializable value (a circular reference) throws inside `JSON.stringify`; this catches that
 * throw so it can be mapped to the same rejected-but-redirect-unaffected path as an oversized
 * payload, rather than letting it escape as an unhandled 500 on an otherwise-successful redirect
 * response. A value that `JSON.stringify` silently drops/coerces (a function, a bare `undefined`
 * inside a nested field) is NOT treated as an error here — the extension is solely responsible
 * for interpreting whatever round-trips, same posture as `resourceId`.
 */
export function validatePendingStateSize(
  value: Record<string, unknown>,
  maxBytes: number
): PendingStateValidation {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'not_serializable' }
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) return { ok: false, reason: 'too_large' }
  return { ok: true }
}

/**
 * Story 40.1 AC11 (rule-of-three extraction) — parses a pending-state row's stored
 * `state_json`/`stateJson` column back into the plain object PV stores/returns verbatim. Returns
 * `undefined` for anything that doesn't parse to a non-array object (corrupt/malformed row) —
 * shared by 39.1's `parsePendingStateJson` (`oauth-handoff-routes.ts`) and this story's
 * `stateFromRow` (`extension-request-state.ts`), both of which previously hand-copied the
 * identical try/catch-and-shape-check.
 */
export function parsePendingStateJson(stateJson: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stateJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Pre-Mortem finding 2 (39.1) — computed by Postgres's own `now()`, never the API process's
 * `Date.now()`, so multi-host clock drift can never make the effective TTL longer or shorter
 * than intended. Shared by both tables' insert path. */
export function ttlExpiresAtSql(ttlMs: number): SQL {
  return sql`now() + (interval '1 millisecond' * ${ttlMs})`
}

/** The two pending-state tables this module currently serves — both share the identical
 * `cookie_hash`/`consumed_at`/`expires_at` column shape the burn/peek queries below depend on.
 * `tableName` is always one of these two fixed literals, from this codebase's own call sites —
 * NEVER user input — so interpolating it as a raw SQL identifier below is safe. */
export type PendingStateTableName = 'extension_oauth_pending_states' | 'extension_request_states'

/** Loosely typed on purpose — this module is generic across two structurally-similar-but-not-
 * identical tables (39.1's table has no `org_id`/`identity_id`; this story's does), so callers
 * narrow the shape they expect via their own typed row-mapping, mirroring how
 * `apps/api/src/extensions/loader.ts`'s own raw `getDb().execute(sql\`...\`)` call sites already
 * cast their result rows. */
export type PendingStateRow = Record<string, unknown> & {
  id: string
  cookie_hash: string
  extension_name: string
  state_json: string
  consumed_at: Date | null
  expires_at: Date
  created_at: Date
}

/**
 * Story 39.1 AC3 / this story's AC11 rule-of-three extraction — the atomic single-use
 * burn-before-use query: at most one concurrent caller can ever see a non-empty result for a
 * given `cookieHash`. `extraCondition`, when given, is AND-ed into the WHERE clause (AC12's
 * `org_id`/`identity_id` filter for `extension_request_states` — a cross-org/cross-identity
 * consume attempt must not burn the row, so the extra condition is part of the SAME atomic
 * UPDATE's WHERE, not a separate post-hoc check).
 */
export async function burnPendingStateRow(
  tableName: PendingStateTableName,
  cookieHash: string,
  extraCondition?: SQL
): Promise<PendingStateRow | undefined> {
  const rows = (await getDb().execute(sql`
    UPDATE ${sql.raw(tableName)}
    SET consumed_at = now()
    WHERE cookie_hash = ${cookieHash}
      AND consumed_at IS NULL
      AND expires_at > now()
      ${extraCondition ? sql`AND ${extraCondition}` : sql``}
    RETURNING *
  `)) as unknown as PendingStateRow[]
  return rows[0]
}

/**
 * Story 40.1 AC2/AC11 — the non-destructive sibling of `burnPendingStateRow()`: the identical
 * WHERE clause, but a plain SELECT that never touches `consumed_at`. 39.1's table has no
 * non-destructive read path at all (extending it to add one would change 39.1's own shipped AC3
 * security property for an unrelated use case — see this story's Finding section) — this
 * function exists for `extension_request_states` only in practice, but is written generically
 * alongside `burnPendingStateRow()` since both share the identical query shape.
 */
export async function peekPendingStateRow(
  tableName: PendingStateTableName,
  cookieHash: string,
  extraCondition?: SQL
): Promise<PendingStateRow | undefined> {
  const rows = (await getDb().execute(sql`
    SELECT * FROM ${sql.raw(tableName)}
    WHERE cookie_hash = ${cookieHash}
      AND consumed_at IS NULL
      AND expires_at > now()
      ${extraCondition ? sql`AND ${extraCondition}` : sql``}
  `)) as unknown as PendingStateRow[]
  return rows[0]
}
