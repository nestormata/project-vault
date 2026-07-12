import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { organizations, orgMemberships, securityAlerts } from '@project-vault/db/schema'
import {
  createTestUser,
  deleteTestUser,
  withTestOrg,
  withTwoTestOrgs,
} from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { queueEntriesForTemplate } from './expiry-alert-test-helpers.js'
import { runUserDormancyCheckJob } from './user-dormancy-check.js'

const DORMANT_TEMPLATE_ID = 'user.dormant'
const NINETY_ONE_DAYS_AGO = new Date(Date.now() - 91 * 86_400_000)
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000)

async function insertMember(
  orgId: string,
  userId: string,
  overrides: Partial<{
    role: 'owner' | 'admin' | 'member' | 'viewer'
    status: 'active' | 'deactivated'
    lastActiveAt: Date | null
    createdAt: Date
  }> = {}
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({
      orgId,
      userId,
      role: overrides.role ?? 'member',
      status: overrides.status ?? 'active',
      lastActiveAt: overrides.lastActiveAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
  )
}

describe('user dormancy check job (AC-10/AC-11/AC-13)', () => {
  it('fires user.dormant for a member inactive beyond the org threshold (default 90 days)', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-owner')
    const memberId = await createTestUser('user-dormancy-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: NINETY_ONE_DAYS_AGO })

        await runUserDormancyCheckJob(boss)

        const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
        expect(queueEntries.length).toBeGreaterThan(0)
        expect(queueEntries[0]?.payload).toMatchObject({ userId: memberId })

        const alerts = await withOrg(orgId, (tx) =>
          tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
        )
        expect(
          alerts.some((a) => (a.payload as Record<string, unknown>)['userId'] === memberId)
        ).toBe(true)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('does not fire for a user active recently', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-recent-owner')
    const memberId = await createTestUser('user-dormancy-recent-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: TEN_DAYS_AGO })

        await runUserDormancyCheckJob(boss)

        const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('does not re-fire a duplicate alert on a second run (dedupe via partial unique index, AC-11)', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-dedupe-owner')
    const memberId = await createTestUser('user-dormancy-dedupe-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: NINETY_ONE_DAYS_AGO })

        await runUserDormancyCheckJob(boss)
        await runUserDormancyCheckJob(boss)

        const alerts = await withOrg(orgId, (tx) =>
          tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
        )
        const matching = alerts.filter(
          (a) => (a.payload as Record<string, unknown>)['userId'] === memberId
        )
        expect(matching).toHaveLength(1)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('re-fires a new alert when the prior one was dismissed and the user is still dormant', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-redismiss-owner')
    const memberId = await createTestUser('user-dormancy-redismiss-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: NINETY_ONE_DAYS_AGO })

        await runUserDormancyCheckJob(boss)
        await withOrg(orgId, (tx) =>
          tx
            .update(securityAlerts)
            .set({ status: 'dismissed' })
            .where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
        )

        await runUserDormancyCheckJob(boss)

        const alerts = await withOrg(orgId, (tx) =>
          tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
        )
        const matching = alerts.filter(
          (a) => (a.payload as Record<string, unknown>)['userId'] === memberId
        )
        expect(matching).toHaveLength(2)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('fires an independent alert per org for a user shared across two orgs (fix: dedup index was global, not per-org)', async () => {
    // Regression test for a code-review finding: idx_security_alerts_dormant_user was originally
    // keyed only on (payload->>'userId'), with no org_id. Since user_identity_tokens is
    // platform-level and a single user can belong to multiple orgs (D9), the first org's INSERT
    // would silently suppress the second org's otherwise-independent dormant-user alert via
    // ON CONFLICT DO NOTHING — leaving the second org's admins never notified. The index and the
    // ON CONFLICT target now both include org_id, so each org gets its own alert.
    const { boss } = createMockBoss()
    await boss.start()
    const ownerAId = await createTestUser('user-dormancy-crossorg-owner-a')
    const ownerBId = await createTestUser('user-dormancy-crossorg-owner-b')
    const sharedMemberId = await createTestUser('user-dormancy-crossorg-shared')
    try {
      await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
        await insertMember(orgAId, ownerAId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgAId, sharedMemberId, { lastActiveAt: NINETY_ONE_DAYS_AGO })
        await insertMember(orgBId, ownerBId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgBId, sharedMemberId, { lastActiveAt: NINETY_ONE_DAYS_AGO })

        await runUserDormancyCheckJob(boss)

        const alertsA = await withOrg(orgAId, (tx) =>
          tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
        )
        const alertsB = await withOrg(orgBId, (tx) =>
          tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
        )
        expect(
          alertsA.some((a) => (a.payload as Record<string, unknown>)['userId'] === sharedMemberId)
        ).toBe(true)
        expect(
          alertsB.some((a) => (a.payload as Record<string, unknown>)['userId'] === sharedMemberId)
        ).toBe(true)
      })
    } finally {
      await deleteTestUser(ownerAId)
      await deleteTestUser(ownerBId)
      await deleteTestUser(sharedMemberId)
    }
  }, 60_000)

  it('fires for a never-active member whose createdAt is older than the threshold (AC-13)', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-never-active-owner')
    const memberId = await createTestUser('user-dormancy-never-active-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: null, createdAt: NINETY_ONE_DAYS_AGO })

        await runUserDormancyCheckJob(boss)

        const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
        expect(queueEntries.length).toBeGreaterThan(0)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('excludes a deactivated user even if their frozen lastActiveAt is far in the past (AC-13)', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-deactivated-owner')
    const memberId = await createTestUser('user-dormancy-deactivated-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, {
          status: 'deactivated',
          lastActiveAt: NINETY_ONE_DAYS_AGO,
        })

        await runUserDormancyCheckJob(boss)

        const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
        expect(queueEntries).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('uses the org-configured threshold instead of the 90-day default', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-threshold-owner')
    const memberId = await createTestUser('user-dormancy-threshold-member')
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000)
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          tx
            .update(organizations)
            .set({ userDormancyThresholdDays: 30 })
            .where(eq(organizations.id, orgId))
        )
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: fortyDaysAgo })

        await runUserDormancyCheckJob(boss)

        const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
        expect(queueEntries.length).toBeGreaterThan(0)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(memberId)
    }
  }, 60_000)

  it('routes notifications to owner AND admin by default (D12/AC-16)', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const ownerId = await createTestUser('user-dormancy-routing-owner')
    const adminId = await createTestUser('user-dormancy-routing-admin')
    const memberId = await createTestUser('user-dormancy-routing-member')
    try {
      await withTestOrg(async ({ orgId }) => {
        await insertMember(orgId, ownerId, { role: 'owner', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, adminId, { role: 'admin', lastActiveAt: TEN_DAYS_AGO })
        await insertMember(orgId, memberId, { lastActiveAt: NINETY_ONE_DAYS_AGO })

        await runUserDormancyCheckJob(boss)

        const { notificationQueue } = await import('@project-vault/db/schema')
        const rows = await withOrg(orgId, (tx) =>
          tx
            .select()
            .from(notificationQueue)
            .where(eq(notificationQueue.templateId, DORMANT_TEMPLATE_ID))
        )
        const recipientIds = new Set(rows.map((r) => r.recipientUserId))
        expect(recipientIds.has(ownerId)).toBe(true)
        expect(recipientIds.has(adminId)).toBe(true)
      })
    } finally {
      await deleteTestUser(ownerId)
      await deleteTestUser(adminId)
      await deleteTestUser(memberId)
    }
  }, 60_000)
})
