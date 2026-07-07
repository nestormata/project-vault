import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { orgMemberships } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser, withTestOrg } from '@project-vault/db/test-helpers'
import {
  evictOrgMembershipActivityDebounce,
  touchOrgMembershipActivity,
} from './session-activity.js'

/**
 * Story 8.3 D3/AC-9 — org_memberships.lastActiveAt has zero writers anywhere in this codebase
 * prior to this story; without touchOrgMembershipActivity, the dormant-user job would see every
 * user's lastActiveAt as permanently NULL. These tests exercise the write path and its debounce
 * directly (mirroring how touchSessionActivity itself has no dedicated unit test — it is only
 * exercised indirectly via the authenticated-request flow), independent from the HTTP layer.
 */
describe('touchOrgMembershipActivity (AC-9)', () => {
  async function lastActiveAtOf(orgId: string, userId: string): Promise<Date | null> {
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .select({ lastActiveAt: orgMemberships.lastActiveAt })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1)
    )
    return row?.lastActiveAt ?? null
  }

  it('updates org_memberships.lastActiveAt for the (orgId, userId) pair', async () => {
    const ownerId = await createTestUser('touch-activity')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values({ orgId, userId: ownerId, role: 'owner' })
        )
        evictOrgMembershipActivityDebounce(orgId, ownerId)

        expect(await lastActiveAtOf(orgId, ownerId)).toBeNull()

        await touchOrgMembershipActivity(orgId, ownerId)

        const after = await lastActiveAtOf(orgId, ownerId)
        expect(after).not.toBeNull()
        expect(Date.now() - (after as Date).getTime()).toBeLessThan(5_000)
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('debounces a second call within the configured window (no redundant write)', async () => {
    const ownerId = await createTestUser('touch-activity-debounce')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx.insert(orgMemberships).values({ orgId, userId: ownerId, role: 'owner' })
        )
        evictOrgMembershipActivityDebounce(orgId, ownerId)

        await touchOrgMembershipActivity(orgId, ownerId)
        const first = await lastActiveAtOf(orgId, ownerId)

        // Force the underlying UPDATE to a detectably different (stale) timestamp so a second,
        // debounce-skipped call is provably a no-op rather than accidentally re-writing "now"
        // again and looking identical either way.
        const stale = new Date(Date.now() - 120_000)
        await withOrg(orgId, (tx) =>
          tx
            .update(orgMemberships)
            .set({ lastActiveAt: stale })
            .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, ownerId)))
        )

        await touchOrgMembershipActivity(orgId, ownerId)
        const second = await lastActiveAtOf(orgId, ownerId)

        expect(second?.getTime()).toBe(stale.getTime())
        expect(second?.getTime()).not.toBe(first?.getTime())
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })

  it('is a no-op (does not throw) for an org/user pair with no membership row', async () => {
    const orphanOrgId = randomUUID()
    const orphanUserId = randomUUID()
    evictOrgMembershipActivityDebounce(orphanOrgId, orphanUserId)
    await expect(touchOrgMembershipActivity(orphanOrgId, orphanUserId)).resolves.toBeUndefined()
  })

  it('scopes its debounce key by orgId AND userId, not userId alone', async () => {
    const ownerId = await createTestUser('touch-activity-multi-org')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrg(orgAId, (tx) =>
            tx.insert(orgMemberships).values({ orgId: orgAId, userId: ownerId, role: 'owner' })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(orgMemberships).values({ orgId: orgBId, userId: ownerId, role: 'owner' })
          )
          evictOrgMembershipActivityDebounce(orgAId, ownerId)
          evictOrgMembershipActivityDebounce(orgBId, ownerId)

          await touchOrgMembershipActivity(orgAId, ownerId)
          // Org B's debounce window is independent of Org A's — this call must not be skipped.
          await touchOrgMembershipActivity(orgBId, ownerId)

          expect(await lastActiveAtOf(orgAId, ownerId)).not.toBeNull()
          expect(await lastActiveAtOf(orgBId, ownerId)).not.toBeNull()
        })
      })
    } finally {
      await deleteTestUser(ownerId)
    }
  })
})
