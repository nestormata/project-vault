import { createHmac } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { currentAuditKeyVersion } from './key-version.js'

type JsonLike =
  string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike | undefined }

/** Canonical key-sorting for HMAC input — exported so Story 9.4's platform-audit equivalent
 * (`modules/platform-audit/write-entry.ts`) can reuse it verbatim rather than duplicating it. */
export function sortKeys(value: unknown): JsonLike {
  if (value === null || typeof value !== 'object') {
    return value as JsonLike
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item))
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortKeys(nested)])
  )
}

// ---------------------------------------------------------------------------------------------
// Story 1.26 (CodeQL js/insufficient-password-hash, alerts #1 and #10 — both DISMISSED as false
// positives, do not re-litigate without new evidence): CodeQL's query flags any identifier whose
// name matches its `maybePassword()` heuristic (`([_-]|\b)mfa([_-]|\b)`, `api.?(key|tok)`, etc.)
// that reaches a hash/HMAC sink. Audit event-type constants (`AuditEvent.MFA_ENROLLED`,
// `MACHINE_USER_API_KEY_*`) and counters (`apiKeysRevokedCount`) match that regex purely by name
// and flow into this function's `fields` argument — none of them are password material. This is
// a keyed HMAC-SHA256 over canonical audit-row JSON for tamper-evidence chaining (Story 1.25), a
// message-authentication use case, not password-at-rest storage; real user passwords use Argon2
// (`@project-vault/crypto`). An attempted structural fix (narrowing `fields` from a bare
// `Record<string, unknown>` to the two named interfaces below, so CodeQL's dataflow tracks
// distinct shapes instead of one undifferentiated bag) did NOT change the analysis result —
// CodeQL's taint-tracking here follows runtime property construction, not declared TS types. A
// follow-up review of CodeQL's own query source (`InsufficientPasswordHashCustomizations.qll`)
// confirmed there is no non-evasive code change that clears this: the query's only barrier is an
// abstract `Sanitizer` with no default subclasses, and it doesn't honor models-as-data. Renaming
// the flagged identifiers, rerouting the data, or switching to an unmodeled crypto API would all
// be evasion, not fixes. If this alert reappears (a new fingerprint is likely after any edit to
// the lines around the `createHmac` call below), dismiss it again with the same justification
// rather than re-attempting a code fix — see alert #10's dismissal comment on GitHub for the
// full text. The type-narrowing below is kept anyway as a genuine, independent type-safety
// improvement over the original `Record<string, unknown>` shape.
//
// `payload: Record<string, unknown>` deliberately stays generic on both shapes below — different
// event types carry genuinely varied payload shapes, and narrowing that further is out of scope.
// ---------------------------------------------------------------------------------------------

/** The `audit_log_entries` row shape — the majority of `computeAuditHmac` call sites (human,
 * machine, extension, system-actor writes, plus `verify.ts`'s recomputation). `previousEntryHmac`
 * is `string`, not `string | null`: every real call site already coerces the DB's nullable
 * previous-hmac read via `?? GENESIS_SENTINEL` before it ever reaches this function (see
 * `human-entry.ts`), so a nullable field type here would be wider than the actual contract. */
export interface AuditLogEntryHmacFields {
  orgId: string
  actorTokenId: string | null
  actorType: string
  eventType: string
  resourceId?: string
  resourceType?: string
  payload: Record<string, unknown>
  keyVersion: number
  previousEntryHmac: string
}

/** The `platform_security_events` row shape — the pre-org-resolution rejection paths
 * (`auth/service.ts`'s `insertPlatformSecurityEvent`, `auth/sso-routes.ts`'s
 * `writePlatformSsoRejected`, `auth/handoff-security-events.ts`'s `writeHandoffSecurityEvent`).
 * This table has no `org_id`/`actorTokenId`/chain-linkage columns at all — genuinely a different
 * shape from `AuditLogEntryHmacFields`, not an approximation of it. */
export interface PlatformSecurityEventHmacFields {
  eventType: string
  subjectHash: string | null
  emailDomain: string | null
  payload: Record<string, unknown>
  keyVersion: number
}

export type AuditHmacFields = AuditLogEntryHmacFields | PlatformSecurityEventHmacFields

/** Canonical JSON: sorted keys, no whitespace; matches the Story 8.1 audit HMAC contract. */
export function computeAuditHmac(fields: AuditHmacFields, auditKey: Buffer): string {
  const canonical = JSON.stringify(sortKeys(fields))
  return createHmac('sha256', auditKey).update(canonical).digest('hex')
}

// ---------------------------------------------------------------------------------------------
// Story 1.25 (HIGH finding, chain-link audit HMACs so a deleted row breaks verification): a
// shared previous-row lookup, exported for `platform-audit/write-entry.ts` to reuse the same way
// it already reuses `sortKeys` above (AC-2) — one implementation, one lock discipline, for both
// modules' otherwise-identical "read the chain tail under an advisory lock" logic.
// ---------------------------------------------------------------------------------------------

/** AC-2: a fixed, well-known sentinel folded into the FIRST row of a chain's HMAC digest input
 * (never stored anywhere — the actual `previous_entry_hmac` column stores `null` for a genesis
 * row, never this string). Distinguishes "genuinely the first row" from "caller forgot to pass
 * previousEntryHmac", which an omitted field could never do. */
export const GENESIS_SENTINEL = 'GENESIS'

export type PreviousEntryHmacScope =
  // audit_log_entries: per-org chain — both the advisory lock and the previous-row lookup are
  // scoped by org_id (Edge Case: "Cross-org chain isolation" — getting this wrong either
  // serializes unrelated orgs against each other or, worse, links one org's chain into another's).
  | { table: 'audit_log_entries'; orgId: string }
  // platform_audit_events: single global chain — no org_id column exists on this table (D11).
  | { table: 'platform_audit_events' }

/**
 * AC-2: acquires a transaction-scoped advisory lock (released automatically at transaction end,
 * `pg_advisory_xact_lock` — never a session-scoped lock needing an explicit unlock) that
 * serializes concurrent writers to the same chain, then reads the current chain tail's `hmac`
 * inside that same lock/transaction. Returns `null` when the chain has no rows yet (this is the
 * correct, ordinary signal for "the next row is genesis" — never a special case).
 *
 * Must be called inside the same transaction as the row's own INSERT, after this lock is held,
 * so no other concurrent writer can observe (or extend past) the same "previous row" between the
 * read here and the insert that follows it.
 */
export async function getPreviousEntryHmac(
  tx: Tx,
  scope: PreviousEntryHmacScope
): Promise<string | null> {
  if (scope.table === 'audit_log_entries') {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('audit-chain:' || ${scope.orgId}, 0))`
    )
    const rows = await tx.execute<{ hmac: string }>(
      sql`SELECT hmac FROM audit_log_entries WHERE org_id = ${scope.orgId} ORDER BY chain_seq DESC LIMIT 1`
    )
    return rows[0]?.hmac ?? null
  }

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('platform-audit-chain', 0))`)
  const rows = await tx.execute<{ hmac: string }>(
    sql`SELECT hmac FROM platform_audit_events ORDER BY chain_seq DESC LIMIT 1`
  )
  return rows[0]?.hmac ?? null
}

// ---------------------------------------------------------------------------------------------
// jscpd fix (Story 1.25 CI-gate finding): every `audit_log_entries` write site reads the SAME
// two-value pair — the current audit key version, then the chain tail's hmac — via the SAME two
// calls in the SAME order (currentAuditKeyVersion(tx) before getPreviousEntryHmac(tx, {...})),
// before computing this row's own hmac. That 2-statement boilerplate was duplicated verbatim
// across 9 call sites. Consolidated here into one helper; behavior is unchanged — it performs
// the exact same two calls, in the exact same order, inside the same transaction the caller
// passes in.
// ---------------------------------------------------------------------------------------------

/**
 * Reads this org's audit-chain head: the current audit key version and the chain tail's hmac
 * (or `null` for a not-yet-started chain). Must be called inside the same transaction as the
 * row's own INSERT (see `getPreviousEntryHmac`'s own doc comment on lock/read ordering).
 *
 * Deliberately scoped to `audit_log_entries` + `currentAuditKeyVersion` only — the
 * `platform_audit_events` call site (`modules/platform-audit/write-entry.ts`) reads a different
 * key version (`currentPlatformAuditKeyVersion`, a distinct signing key per D3) and has no
 * `orgId`, so it does not share this exact shape and keeps its own two calls.
 */
export async function readAuditChainHead(
  tx: Tx,
  orgId: string
): Promise<{ keyVersion: number; previousEntryHmac: string | null }> {
  const keyVersion = await currentAuditKeyVersion(tx)
  const previousEntryHmac = await getPreviousEntryHmac(tx, { table: 'audit_log_entries', orgId })
  return { keyVersion, previousEntryHmac }
}
