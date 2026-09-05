import { createHmac } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'

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

/** Canonical JSON: sorted keys, no whitespace; matches the Story 8.1 audit HMAC contract. */
export function computeAuditHmac(fields: Record<string, unknown>, auditKey: Buffer): string {
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
