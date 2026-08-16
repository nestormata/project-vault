import { and, isNull, gt, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { sessions } from '@project-vault/db/schema'
import { fetchAllOrgIds } from '../middleware/rls.js'

/**
 * Story 23.2 AC-12: `sessionsLive` — the ONE DB read the admin-only extensions/status envelope
 * is permitted (the boot-time `/health` route stays a no-DB-read, boot-resolved-only surface).
 * `sessions` is org-scoped/RLS (no instance-wide table to query directly), so this sums a
 * per-org count across every org the same way `native-login-policy.ts`'s own audit fanout and
 * `recovery.ts`'s `activeOrgMembershipsForUser` already iterate every org under `withOrg()` —
 * an accepted, already-precedented tradeoff in this codebase for instance-wide numbers with no
 * single-query home. "Live" mirrors the session-validity check used elsewhere (session.ts):
 * not revoked and not yet expired.
 */
export async function countLiveSessionsAcrossInstance(): Promise<number> {
  const orgIds = await fetchAllOrgIds()
  let total = 0
  for (const orgId of orgIds) {
    const count = await withOrg(orgId, async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      return row?.count ?? 0
    })
    total += count
  }
  return total
}
