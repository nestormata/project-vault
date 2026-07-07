import { and, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships, sessions } from '@project-vault/db/schema'
import { env } from '../../config/env.js'

const lastActivityWrite = new Map<string, number>()

export function evictSessionActivityDebounce(sessionId: string): void {
  lastActivityWrite.delete(sessionId)
}

export async function touchSessionActivity(sessionId: string, orgId: string): Promise<void> {
  const now = Date.now()
  const last = lastActivityWrite.get(sessionId) ?? 0
  if (now - last < env.SESSION_ACTIVITY_DEBOUNCE_SECONDS * 1000) return
  // sessions is RLS-protected (sessions_isolation in 0001_rls_and_triggers.sql): a bare,
  // non-transactional getDb() call has no app.current_org_id set, so the policy silently
  // matches zero rows and this UPDATE becomes a no-op — confirmed via direct probe. Must
  // run inside withOrg() for the write to actually land.
  await withOrg(orgId, (tx) =>
    tx
      .update(sessions)
      .set({ lastActiveAt: new Date(now), updatedAt: new Date(now) })
      .where(eq(sessions.id, sessionId))
  )
  lastActivityWrite.set(sessionId, now)
}

// Story 8.3 D3/AC-9: org_memberships.lastActiveAt (packages/db/src/schema/org-memberships.ts)
// is a real, already-migrated column with zero writers anywhere in this codebase prior to this
// story. Without this write path, the dormant-user detection job (workers/user-dormancy-check.ts)
// would see every user's lastActiveAt as permanently NULL, making the feature non-functional for
// anyone who has ever been active. Own debounce map, keyed by `${orgId}:${userId}` (not
// sessionId — activity here is scoped to an org membership, which can outlive any one session),
// reusing the same env.SESSION_ACTIVITY_DEBOUNCE_SECONDS window as touchSessionActivity rather
// than introducing a second, redundant env var.
const lastOrgMembershipActivityWrite = new Map<string, number>()

function orgMembershipActivityKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`
}

export function evictOrgMembershipActivityDebounce(orgId: string, userId: string): void {
  lastOrgMembershipActivityWrite.delete(orgMembershipActivityKey(orgId, userId))
}

export async function touchOrgMembershipActivity(orgId: string, userId: string): Promise<void> {
  const key = orgMembershipActivityKey(orgId, userId)
  const now = Date.now()
  const last = lastOrgMembershipActivityWrite.get(key) ?? 0
  if (now - last < env.SESSION_ACTIVITY_DEBOUNCE_SECONDS * 1000) return
  // org_memberships is RLS-protected the same way sessions is (confirmed by direct probe: a
  // bare, non-transactional getDb() query has no app.current_org_id set, so the RLS policy —
  // org_id = current_setting('app.current_org_id') — silently matches zero rows and the UPDATE
  // becomes a no-op). This write must run inside withOrg() to actually land, same as
  // touchSessionActivity's write does.
  await withOrg(orgId, (tx) =>
    tx
      .update(orgMemberships)
      .set({ lastActiveAt: new Date(now), updatedAt: new Date(now) })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  )
  lastOrgMembershipActivityWrite.set(key, now)
}
