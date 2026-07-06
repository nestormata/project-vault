import type postgres from 'postgres'

export class AuditActorTokenCoverageGapError extends Error {
  constructor(public readonly gapCount: number) {
    super(`Audit actor-token coverage gap: ${gapCount} human-actor row(s) with no actor_token_id`)
  }
}

/**
 * D3 — the "backfill check" PJ6 asked for, reinterpreted for this codebase's actual schema:
 * `actor_token_id` is a real FK to `user_identity_tokens(id)`, so a raw non-token UUID can never
 * be inserted (the FK constraint rejects it). The real residual gap is `actor_token_id IS NULL`
 * on a human-actor row — such a row can never be pseudonymized under Story 8.3's GDPR erasure
 * flow, since there is no token to alias. Scoped to `actor_type = 'human'` only (D3) —
 * `actor_type = 'machine_user'` is an explicit non-goal for this story.
 *
 * AC-14 (critical isolation requirement): this is a database-wide gate, deliberately not scoped
 * to one org. `audit_log_entries` is protected by the org-scoped `audit_log_isolation` RLS
 * policy, so the caller MUST pass a connection that bypasses RLS (the Postgres superuser —
 * `DB_URL_SUPERUSER` in the Makefile, not `DB_URL_APP`/`vault_app`) — otherwise, with no
 * `app.current_org_id` GUC set, RLS silently hides every row and this check would always
 * (falsely) report zero gaps regardless of real data.
 */
export async function checkAuditActorTokenCoverage(
  sql: postgres.Sql | postgres.TransactionSql
): Promise<void> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM audit_log_entries
    WHERE actor_type = 'human' AND actor_token_id IS NULL
  `
  const gapCount = Number(rows[0]?.count ?? 0)
  if (gapCount > 0) throw new AuditActorTokenCoverageGapError(gapCount)
}
