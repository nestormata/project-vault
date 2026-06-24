import { sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from './index.js'

export async function withTestOrg<T>(
  fn: (ctx: { orgId: string; tx: Tx }) => Promise<T>
): Promise<T> {
  const orgId = crypto.randomUUID()
  const slugSuffix = orgId.slice(0, 8)
  await getDb().execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${'test-org-' + slugSuffix}, ${'test-' + slugSuffix})`
  )
  try {
    return await withOrg(orgId, (tx) => fn({ orgId, tx }))
  } finally {
    // Delete non-cascading children FIRST to avoid FK constraint violations.
    // audit_log_entries and security_alerts have no ON DELETE CASCADE on org_id.
    // org_memberships and sessions DO have CASCADE — they are cleaned up automatically.
    //
    // Both deletes MUST run inside withOrg() — a bare getDb().execute() has no
    // app.current_org_id set, so the RLS policy silently filters the DELETE to zero
    // rows (no error, just a no-op) instead of actually removing the row.
    //
    // audit_log_entries is also append-only (AC-5 trigger blocks ALL deletes, even
    // this one). A test org that wrote audit log rows can never be fully purged —
    // that is correct, intentional behavior (same as production), not a cleanup bug.
    // Swallow the expected failure here so it doesn't mask the test's actual
    // pass/fail result, and skip the organizations delete too since the FK would
    // block it anyway.
    try {
      await withOrg(orgId, (tx) =>
        tx.execute(sql`DELETE FROM audit_log_entries WHERE org_id = ${orgId}`)
      )
      await withOrg(orgId, (tx) =>
        tx.execute(sql`DELETE FROM security_alerts WHERE org_id = ${orgId}`)
      )
      await getDb().execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
    } catch {
      // Expected when this test org wrote append-only audit log rows; org row remains.
    }
  }
}
