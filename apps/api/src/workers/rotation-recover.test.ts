import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialVersions,
  notificationQueue,
  orgMemberships,
  rotationChecklistItems,
  rotations,
} from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { BossService } from '../lib/boss.js'
import {
  ensureWorkerTestEnv,
  seedWorkerCredential,
  seedWorkerProject,
  unsealWorkerTestVault,
} from './worker-test-helpers.js'

ensureWorkerTestEnv()

const { initVault } = await import('../modules/vault/key-service.js')
const { runStaleRotationRecoveryJob } = await import('./rotation-recover.js')

const TEST_PASSPHRASE = 'rotation-recover-passphrase'
const STALE_DETECTED = 'rotation.stale_detected'

function noopBoss(): BossService {
  // Real BossService, never started — sendNotificationJobs() checks isStarted() and no-ops
  // when false (identical "boss not started" guard as every other worker's post-commit send).
  return new BossService(() => {
    throw new Error('should not be called — boss is never started in this test')
  })
}

const seedProject = (orgId: string) => seedWorkerProject(orgId, 'Recover')
const seedCredential = (orgId: string, projectId: string) =>
  seedWorkerCredential(orgId, projectId, 'Recover')

async function seedVersion(orgId: string, credentialId: string, versionNumber: number) {
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({ orgId, credentialId, versionNumber })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected test version to be inserted')
  return version.id
}

async function seedUser(label: string): Promise<string> {
  const { createTestUser } = await import('@project-vault/db/test-helpers')
  return createTestUser(label)
}

async function seedOwnerMembership(orgId: string, userId: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(orgMemberships).values({ orgId, userId, role: 'owner', status: 'active' })
  )
}

async function seedInProgressRotation(
  orgId: string,
  projectId: string,
  credentialId: string,
  initiatedBy: string,
  initiatedAt: Date
): Promise<string> {
  const previousVersionId = await seedVersion(orgId, credentialId, 1)
  const newVersionId = await seedVersion(orgId, credentialId, 2)
  const [rotation] = await withOrg(orgId, (tx) =>
    tx
      .insert(rotations)
      .values({
        orgId,
        projectId,
        credentialId,
        newVersionId,
        previousVersionId,
        status: 'in_progress',
        initiatedBy,
        initiatedAt,
      })
      .returning({ id: rotations.id })
  )
  if (!rotation) throw new Error('expected test rotation to be inserted')
  return rotation.id
}

async function rotationState(orgId: string, rotationId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ status: rotations.status, version: rotations.version })
      .from(rotations)
      .where(eq(rotations.id, rotationId))
  )
  return row
}

const MINUTES = 60_000

describe.sequential('runStaleRotationRecoveryJob', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealWorkerTestVault(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('transitions an in_progress rotation older than the threshold to stale_recovery', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-initiator')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const staleInitiatedAt = new Date(Date.now() - 61 * MINUTES)
      const rotationId = await seedInProgressRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        staleInitiatedAt
      )

      await runStaleRotationRecoveryJob(noopBoss())

      const state = await rotationState(orgId, rotationId)
      expect(state?.status).toBe('stale_recovery')
      expect(state?.version).toBe(2)
    })
  }, 20_000)

  it('boundary: a rotation initiated just under 60min ago is NOT picked up; just over 60min ago IS (default 60-min threshold)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-boundary')
      const projectId = await seedProject(orgId)
      const credentialIdA = await seedCredential(orgId, projectId)
      const credentialIdB = await seedCredential(orgId, projectId)

      // Margin is wider than a single second: the seed calls above and the job run below each take
      // real wall-clock time, so a ~1s margin flakes as elapsed test time erodes it.
      const notYetStale = new Date(Date.now() - (60 * MINUTES - 30_000))
      const alreadyStale = new Date(Date.now() - (60 * MINUTES + 30_000))
      const rotationNotStale = await seedInProgressRotation(
        orgId,
        projectId,
        credentialIdA,
        userId,
        notYetStale
      )
      const rotationStale = await seedInProgressRotation(
        orgId,
        projectId,
        credentialIdB,
        userId,
        alreadyStale
      )

      await runStaleRotationRecoveryJob(noopBoss())

      expect((await rotationState(orgId, rotationNotStale))?.status).toBe('in_progress')
      expect((await rotationState(orgId, rotationStale))?.status).toBe('stale_recovery')
    })
  }, 20_000)

  it('is a no-op when no rotation is stale', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-noop')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const rotationId = await seedInProgressRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        new Date()
      )

      await expect(runStaleRotationRecoveryJob(noopBoss())).resolves.not.toThrow()
      expect((await rotationState(orgId, rotationId))?.status).toBe('in_progress')
    })
  }, 20_000)

  it('resets failed/max_retries_exceeded checklist items to unconfirmed, preserving retryCount, and leaves confirmed items untouched', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-checklist')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const rotationId = await seedInProgressRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        new Date(Date.now() - 90 * MINUTES)
      )

      const [confirmedItem, failedItem, maxExceededItem] = await withOrg(orgId, (tx) =>
        tx
          .insert(rotationChecklistItems)
          .values([
            { orgId, rotationId, systemName: 'confirmed-system', status: 'confirmed' },
            { orgId, rotationId, systemName: 'failed-system', status: 'failed', retryCount: 1 },
            {
              orgId,
              rotationId,
              systemName: 'max-exceeded-system',
              status: 'max_retries_exceeded',
              retryCount: 3,
            },
          ])
          .returning({ id: rotationChecklistItems.id })
      )
      if (!confirmedItem || !failedItem || !maxExceededItem) {
        throw new Error('expected 3 checklist items to be inserted')
      }

      await runStaleRotationRecoveryJob(noopBoss())

      const items = await withOrg(orgId, (tx) =>
        tx
          .select({
            id: rotationChecklistItems.id,
            status: rotationChecklistItems.status,
            retryCount: rotationChecklistItems.retryCount,
          })
          .from(rotationChecklistItems)
          .where(eq(rotationChecklistItems.rotationId, rotationId))
      )
      const byId = new Map(items.map((item) => [item.id, item]))

      expect(byId.get(confirmedItem.id)?.status).toBe('confirmed')
      expect(byId.get(failedItem.id)).toMatchObject({ status: 'unconfirmed', retryCount: 1 })
      expect(byId.get(maxExceededItem.id)).toMatchObject({ status: 'unconfirmed', retryCount: 3 })
    })
  }, 20_000)

  it('writes a system-actor rotation.stale_detected audit row with thresholdMinutes/pendingItemsReset', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-audit')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const rotationId = await seedInProgressRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        new Date(Date.now() - 90 * MINUTES)
      )
      await withOrg(orgId, (tx) =>
        tx
          .insert(rotationChecklistItems)
          .values([{ orgId, rotationId, systemName: 'failed-system', status: 'failed' }])
      )

      await runStaleRotationRecoveryJob(noopBoss())

      const auditRows = await withOrg(orgId, (tx) =>
        tx
          .select({ actorType: auditLogEntries.actorType, payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, STALE_DETECTED))
      )
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]?.actorType).toBe('system')
      expect(auditRows[0]?.payload).toMatchObject({
        credentialId,
        initiatedBy: userId,
        pendingItemsReset: 1,
      })
    })
  }, 20_000)

  it('enqueues both the direct-to-initiator and FR100-routed notifications', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-notify')
      await seedOwnerMembership(orgId, userId)
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      await seedInProgressRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        new Date(Date.now() - 90 * MINUTES)
      )

      await runStaleRotationRecoveryJob(noopBoss())

      const queueRows = await withOrg(orgId, (tx) =>
        tx
          .select({
            templateId: notificationQueue.templateId,
            recipientUserId: notificationQueue.recipientUserId,
          })
          .from(notificationQueue)
          .where(eq(notificationQueue.templateId, 'rotation.stale'))
      )
      expect(queueRows.length).toBeGreaterThanOrEqual(1)
      expect(queueRows.some((row) => row.recipientUserId === userId)).toBe(true)
    })
  }, 20_000)

  it('skips a rotation whose advisory lock is held by a concurrent transaction (silent skip, no error)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('recover-lock-held')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const rotationId = await seedInProgressRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        new Date(Date.now() - 90 * MINUTES)
      )

      const sql = postgres(process.env['DATABASE_URL'] as string)
      const reservedSql = await sql.reserve()
      try {
        await reservedSql`BEGIN`
        await reservedSql`SELECT pg_advisory_xact_lock(hashtextextended('rotation:' || ${orgId} || ':' || ${rotationId}, 0))`

        await expect(runStaleRotationRecoveryJob(noopBoss())).resolves.not.toThrow()

        const state = await rotationState(orgId, rotationId)
        expect(state?.status).toBe('in_progress')

        await reservedSql`ROLLBACK`
      } finally {
        reservedSql.release()
        await sql.end()
      }

      // Once the lock is released, the next run picks it up.
      await runStaleRotationRecoveryJob(noopBoss())
      expect((await rotationState(orgId, rotationId))?.status).toBe('stale_recovery')
    })
  }, 20_000)
})
