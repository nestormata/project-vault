import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { sessions } from '@project-vault/db/schema'
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
