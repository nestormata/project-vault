import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { credentialShareNudgeDismissals, credentialShares } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { seedWorkerCredential, seedWorkerProject } from '../../workers/worker-test-helpers.js'
import { computeRotationRecommendedNudges } from './nudge.js'

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

async function seedShare(
  orgId: string,
  credentialId: string,
  userId: string,
  overrides: Partial<{
    status: 'active' | 'viewed' | 'revoked' | 'expired' | 'superseded'
    fieldKey: string | null
    createdAt: Date
    recipientEmail: string | null
  }> = {}
): Promise<string> {
  const [share] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialShares)
      .values({
        orgId,
        credentialId,
        fieldKey: overrides.fieldKey ?? null,
        sharedBy: userId,
        recipientType: overrides.recipientEmail ? 'external' : 'user',
        recipientUserId: overrides.recipientEmail ? null : userId,
        recipientEmail: overrides.recipientEmail ?? null,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        status: overrides.status ?? 'active',
        createdAt: overrides.createdAt ?? new Date(),
      })
      .returning({ id: credentialShares.id })
  )
  if (!share) throw new Error('expected test share to be inserted')
  return share.id
}

async function seedDismissal(
  orgId: string,
  credentialId: string,
  userId: string,
  fieldKey: string | null,
  dismissedAt: Date
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(credentialShareNudgeDismissals).values({
      orgId,
      credentialId,
      fieldKey,
      dismissedBy: userId,
      dismissedAt,
      reason: 'test dismissal',
    })
  )
}

async function cleanup(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx
      .delete(credentialShareNudgeDismissals)
      .where(eq(credentialShareNudgeDismissals.dismissedBy, userId))
  )
  await withOrg(orgId, (tx) =>
    tx.delete(credentialShares).where(eq(credentialShares.sharedBy, userId))
  )
}

describe.sequential('computeRotationRecommendedNudges', () => {
  beforeAll(async () => {
    await resetVaultForTest()
  })
  afterAll(async () => {
    await resetVaultForTest()
  })

  it('AC-11: a credential never shared has no buckets at all', async () => {
    const userId = await createTestUser('nudge-never-shared')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'NudgeNeverShared')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'NudgeNeverShared')

        const buckets = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(buckets).toHaveLength(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC-11: active is true after a share, false after dismissal, true again after a later share (re-trigger)', async () => {
    const userId = await createTestUser('nudge-lifecycle')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'NudgeLifecycle')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'NudgeLifecycle')

        await seedShare(orgId, credentialId, userId, { createdAt: daysAgo(10) })
        const afterShare = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(afterShare).toHaveLength(1)
        expect(afterShare[0]?.active).toBe(true)

        await seedDismissal(orgId, credentialId, userId, null, daysAgo(5))
        const afterDismissal = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(afterDismissal[0]?.active).toBe(false)

        const recentShareCreatedAt = daysAgo(2)
        await seedShare(orgId, credentialId, userId, { createdAt: recentShareCreatedAt })
        const afterReshare = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(afterReshare[0]?.active).toBe(true)
        expect(afterReshare[0]?.mostRecentShareAt).toBe(recentShareCreatedAt.toISOString())

        await cleanup(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC-11 edge case: a revoked or expired (but not superseded) share still counts toward active', async () => {
    const userId = await createTestUser('nudge-revoked-expired')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'NudgeRevokedExpired')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'NudgeRevokedExpired')

        await seedShare(orgId, credentialId, userId, { status: 'revoked' })
        const revokedResult = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(revokedResult[0]?.active).toBe(true)

        await cleanup(orgId, userId)

        await seedShare(orgId, credentialId, userId, { status: 'expired' })
        const expiredResult = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(expiredResult[0]?.active).toBe(true)

        await cleanup(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC-11: a superseded share does not count toward active', async () => {
    const userId = await createTestUser('nudge-superseded')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'NudgeSuperseded')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'NudgeSuperseded')

        await seedShare(orgId, credentialId, userId, { status: 'superseded' })
        const result = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        expect(result[0]?.active).toBe(false)

        await cleanup(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('AC-11: multi-field independent nudge state — dismissing one field bucket does not clear another', async () => {
    const userId = await createTestUser('nudge-multi-field')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedWorkerProject(orgId, 'NudgeMultiField')
        const credentialId = await seedWorkerCredential(orgId, projectId, 'NudgeMultiField')

        await seedShare(orgId, credentialId, userId, { fieldKey: 'api_key', createdAt: daysAgo(3) })
        await seedShare(orgId, credentialId, userId, {
          fieldKey: 'webhook_secret',
          createdAt: daysAgo(3),
        })
        await seedDismissal(orgId, credentialId, userId, 'api_key', daysAgo(1))

        const buckets = await withOrg(orgId, (tx) =>
          computeRotationRecommendedNudges(tx, { orgId, credentialId })
        )
        const apiKeyBucket = buckets.find((b) => b.fieldKey === 'api_key')
        const webhookBucket = buckets.find((b) => b.fieldKey === 'webhook_secret')
        expect(apiKeyBucket?.active).toBe(false)
        expect(webhookBucket?.active).toBe(true)

        await cleanup(orgId, userId)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
