import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialVersions, rotations } from '@project-vault/db/schema'
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
const { runStaleStagedAlertJob } = await import('./rotation-stale-staged-alert.js')
const { runStaleRotationRecoveryJob } = await import('./rotation-recover.js')

const TEST_PASSPHRASE = 'rotation-stale-staged-alert-passphrase'
const STALE_STAGED_DETECTED = 'rotation.stale_staged_detected'

function noopBoss(): BossService {
  return new BossService(() => {
    throw new Error('should not be called — boss is never started in this test')
  })
}

const seedProject = (orgId: string) => seedWorkerProject(orgId, 'StaleStaged')
const seedCredential = (orgId: string, projectId: string) =>
  seedWorkerCredential(orgId, projectId, 'StaleStaged')

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

async function seedStagedRotation(
  orgId: string,
  projectId: string,
  credentialId: string,
  initiatedBy: string | null,
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
        status: 'staged',
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
      .select({ status: rotations.status, staleStagedAlertedAt: rotations.staleStagedAlertedAt })
      .from(rotations)
      .where(eq(rotations.id, rotationId))
  )
  return row
}

async function staleStagedAuditCount(orgId: string, rotationId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ payload: auditLogEntries.payload })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.eventType, STALE_STAGED_DETECTED))
  )
  return rows.filter((row) => (row.payload as { rotationId?: string }).rotationId === rotationId)
    .length
}

const DAYS = 24 * 60 * 60 * 1000
const MINUTES = 60_000

describe.sequential('runStaleStagedAlertJob', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealWorkerTestVault(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('AC-4.1/4.4: alerts a staged rotation older than the (default 14-day) threshold, writing the audit event and never touching status', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('stale-staged-initiator')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const staleInitiatedAt = new Date(Date.now() - 15 * DAYS)
      const rotationId = await seedStagedRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        staleInitiatedAt
      )

      await runStaleStagedAlertJob(noopBoss())

      const state = await rotationState(orgId, rotationId)
      // AC-4.2: NEVER transitions status — this is the literal load-bearing distinction from
      // rotation-recover.ts.
      expect(state?.status).toBe('staged')
      expect(state?.staleStagedAlertedAt).not.toBeNull()
      expect(await staleStagedAuditCount(orgId, rotationId)).toBe(1)
    })
  }, 60_000)

  it('does NOT alert a staged rotation younger than the threshold', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('stale-staged-fresh')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const freshInitiatedAt = new Date(Date.now() - 1 * DAYS)
      const rotationId = await seedStagedRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        freshInitiatedAt
      )

      await runStaleStagedAlertJob(noopBoss())

      const state = await rotationState(orgId, rotationId)
      expect(state?.staleStagedAlertedAt).toBeNull()
    })
  }, 60_000)

  it('is idempotent — a second run against an already-alerted rotation does not re-alert', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('stale-staged-idempotent')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const staleInitiatedAt = new Date(Date.now() - 20 * DAYS)
      const rotationId = await seedStagedRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        staleInitiatedAt
      )

      await runStaleStagedAlertJob(noopBoss())
      expect(await staleStagedAuditCount(orgId, rotationId)).toBe(1)

      await runStaleStagedAlertJob(noopBoss())
      expect(await staleStagedAuditCount(orgId, rotationId)).toBe(1)
    })
  }, 60_000)

  // AC-4 Example 4a: the required collision-avoidance test proving rotation-recover.ts's
  // in_progress-only stale-detection job and this staged-only alert job can never double-fire
  // on the same rotation, at any point in its lifecycle.
  it('AC-4 Example 4a: never collides with rotation-recover.ts — a staged rotation is invisible to the 1h stale_recovery job at any point', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('stale-staged-collision')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      // Older than BOTH the 60-minute stale_recovery threshold AND the 14-day stale-staged
      // threshold, so both jobs' WHERE clauses are exercised against the same row.
      const veryStaleInitiatedAt = new Date(Date.now() - (15 * DAYS + 2 * 60 * MINUTES))
      const rotationId = await seedStagedRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        veryStaleInitiatedAt
      )

      // The 1h crash-recovery job's WHERE status = 'in_progress' must never match a `staged` row.
      await runStaleRotationRecoveryJob(noopBoss())
      expect((await rotationState(orgId, rotationId))?.status).toBe('staged')

      // The new stale-staged job DOES alert, and never touches status.
      await runStaleStagedAlertJob(noopBoss())
      const afterFirstAlert = await rotationState(orgId, rotationId)
      expect(afterFirstAlert?.status).toBe('staged')
      expect(afterFirstAlert?.staleStagedAlertedAt).not.toBeNull()
      expect(await staleStagedAuditCount(orgId, rotationId)).toBe(1)

      // Re-running BOTH jobs again: no re-alert (already alerted), and the crash-recovery job
      // still never matches — status is still `staged`, never became `in_progress`.
      await runStaleStagedAlertJob(noopBoss())
      expect(await staleStagedAuditCount(orgId, rotationId)).toBe(1)
      await runStaleRotationRecoveryJob(noopBoss())
      expect((await rotationState(orgId, rotationId))?.status).toBe('staged')
    })
  }, 60_000)

  it('AC-4b: a promoted rotation (promoted before the alert fired) is never alerted', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await seedUser('stale-staged-promoted')
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const staleInitiatedAt = new Date(Date.now() - 20 * DAYS)
      const rotationId = await seedStagedRotation(
        orgId,
        projectId,
        credentialId,
        userId,
        staleInitiatedAt
      )
      await withOrg(orgId, (tx) =>
        tx.update(rotations).set({ status: 'promoted' }).where(eq(rotations.id, rotationId))
      )

      await runStaleStagedAlertJob(noopBoss())

      expect(await staleStagedAuditCount(orgId, rotationId)).toBe(0)
      expect((await rotationState(orgId, rotationId))?.staleStagedAlertedAt).toBeNull()
    })
  }, 60_000)
})
