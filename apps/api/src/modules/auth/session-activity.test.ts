import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { sessions } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import { evictSessionActivityDebounce, touchSessionActivity } from './session-activity.js'

/**
 * sessions is RLS-protected the same way org_memberships is (sessions_isolation in
 * 0001_rls_and_triggers.sql). touchSessionActivity previously ran its UPDATE through a bare,
 * non-transactional getDb() call with no app.current_org_id set, so the RLS policy silently
 * matched zero rows and the write was a no-op — every authenticated request's debounced touch
 * was silently discarded, and lastActiveAt was only ever advanced by refresh-token rotation.
 * These tests exercise the write path directly so a regression back to a bare getDb() call
 * fails loudly instead of silently doing nothing.
 */
describe('touchSessionActivity', () => {
  async function insertTestSession(orgId: string, userId: string): Promise<string> {
    const [session] = await withOrg(orgId, (tx) =>
      tx
        .insert(sessions)
        .values({
          orgId,
          userId,
          jti: randomUUID(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning({ id: sessions.id })
    )
    if (!session) throw new Error('expected test session to be inserted')
    return session.id
  }

  async function lastActiveAtOf(orgId: string, sessionId: string): Promise<Date | null> {
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .select({ lastActiveAt: sessions.lastActiveAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
    )
    return row?.lastActiveAt ?? null
  }

  it('updates sessions.lastActiveAt for the given session', async () => {
    const userId = await createTestUser('touch-session-activity')
    try {
      await withTestOrg(async ({ orgId }) => {
        const sessionId = await insertTestSession(orgId, userId)
        evictSessionActivityDebounce(sessionId)

        const stale = new Date(Date.now() - 120_000)
        await withOrg(orgId, (tx) =>
          tx.update(sessions).set({ lastActiveAt: stale }).where(eq(sessions.id, sessionId))
        )

        await touchSessionActivity(sessionId, orgId)

        const after = await lastActiveAtOf(orgId, sessionId)
        expect(after).not.toBeNull()
        expect(after?.getTime()).not.toBe(stale.getTime())
        expect(Date.now() - (after as Date).getTime()).toBeLessThan(5_000)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('debounces a second call within the configured window (no redundant write)', async () => {
    const userId = await createTestUser('touch-session-activity-debounce')
    try {
      await withTestOrg(async ({ orgId }) => {
        const sessionId = await insertTestSession(orgId, userId)
        evictSessionActivityDebounce(sessionId)

        await touchSessionActivity(sessionId, orgId)

        // Force the underlying UPDATE to a detectably different (stale) timestamp so a
        // second, debounce-skipped call is provably a no-op rather than accidentally
        // re-writing "now" again and looking identical either way.
        const stale = new Date(Date.now() - 120_000)
        await withOrg(orgId, (tx) =>
          tx.update(sessions).set({ lastActiveAt: stale }).where(eq(sessions.id, sessionId))
        )

        await touchSessionActivity(sessionId, orgId)
        const after = await lastActiveAtOf(orgId, sessionId)

        expect(after?.getTime()).toBe(stale.getTime())
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
