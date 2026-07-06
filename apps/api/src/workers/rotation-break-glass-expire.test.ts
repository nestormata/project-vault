import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentialVersions } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import {
  ensureWorkerTestEnv,
  findAuditRowOrgIds,
  seedWorkerCredential,
  seedWorkerProject,
  unsealWorkerTestVault,
  withTwoTestOrgs,
} from './worker-test-helpers.js'

ensureWorkerTestEnv()

const { initVault } = await import('../modules/vault/key-service.js')
const { runBreakGlassOverlapExpiryJob } = await import('./rotation-break-glass-expire.js')

const TEST_PASSPHRASE = 'rotation-break-glass-expire-passphrase'
const OVERLAP_EXPIRED = 'rotation.break_glass_overlap_expired'

const seedProject = (orgId: string) => seedWorkerProject(orgId, 'BreakGlassExpiry')
const seedCredential = (orgId: string, projectId: string) =>
  seedWorkerCredential(orgId, projectId, 'BreakGlassExpiry')

async function seedOverlappingVersion(
  orgId: string,
  credentialId: string,
  versionNumber: number,
  breakGlassOverlapExpiresAt: Date | null
): Promise<string> {
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({
        orgId,
        credentialId,
        versionNumber,
        rotationLockedAt: breakGlassOverlapExpiresAt ? new Date() : null,
        breakGlassOverlapExpiresAt,
      })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected test version to be inserted')
  return version.id
}

async function versionState(orgId: string, versionId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({
        rotationLockedAt: credentialVersions.rotationLockedAt,
        breakGlassOverlapExpiresAt: credentialVersions.breakGlassOverlapExpiresAt,
      })
      .from(credentialVersions)
      .where(eq(credentialVersions.id, versionId))
  )
  return row
}

describe.sequential('runBreakGlassOverlapExpiryJob', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealWorkerTestVault(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('auto-retires a version whose overlap window has already expired: clears rotationLockedAt and breakGlassOverlapExpiresAt', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const expiredAt = new Date(Date.now() - 60_000)
      const versionId = await seedOverlappingVersion(orgId, credentialId, 1, expiredAt)

      await runBreakGlassOverlapExpiryJob()

      const state = await versionState(orgId, versionId)
      expect(state?.rotationLockedAt).toBeNull()
      expect(state?.breakGlassOverlapExpiresAt).toBeNull()
    })
  }, 20_000)

  it('leaves a version whose overlap window has NOT yet expired untouched', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const futureExpiry = new Date(Date.now() + 60 * 60_000)
      const versionId = await seedOverlappingVersion(orgId, credentialId, 1, futureExpiry)

      await runBreakGlassOverlapExpiryJob()

      const state = await versionState(orgId, versionId)
      expect(state?.rotationLockedAt).not.toBeNull()
      expect(state?.breakGlassOverlapExpiresAt).not.toBeNull()
    })
  }, 20_000)

  it('writes a system-actor rotation.break_glass_overlap_expired audit row per expired version', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      const versionId = await seedOverlappingVersion(
        orgId,
        credentialId,
        1,
        new Date(Date.now() - 1000)
      )

      await runBreakGlassOverlapExpiryJob()

      const auditRows = await withOrg(orgId, (tx) =>
        tx
          .select({ actorType: auditLogEntries.actorType, payload: auditLogEntries.payload })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, OVERLAP_EXPIRED))
      )
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0]?.actorType).toBe('system')
      expect(auditRows[0]?.payload).toMatchObject({
        credentialVersionId: versionId,
        credentialId,
      })
    })
  }, 20_000)

  it('is a no-op (no error, no audit rows) when nothing has an overlap window set', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId)
      await seedOverlappingVersion(orgId, credentialId, 1, null)

      await expect(runBreakGlassOverlapExpiryJob()).resolves.not.toThrow()

      const auditRows = await withOrg(orgId, (tx) =>
        tx
          .select({ id: auditLogEntries.id })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, OVERLAP_EXPIRED))
      )
      expect(auditRows).toHaveLength(0)
    })
  }, 20_000)

  it('attributes each expiry to its own org (no cross-attribution)', async () => {
    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const projectAId = await seedProject(orgAId)
      const projectBId = await seedProject(orgBId)
      const credentialAId = await seedCredential(orgAId, projectAId)
      const credentialBId = await seedCredential(orgBId, projectBId)
      await seedOverlappingVersion(orgAId, credentialAId, 1, new Date(Date.now() - 1000))
      await seedOverlappingVersion(orgBId, credentialBId, 1, new Date(Date.now() - 1000))

      await runBreakGlassOverlapExpiryJob()

      const auditRowsA = await findAuditRowOrgIds(orgAId, OVERLAP_EXPIRED)
      const auditRowsB = await findAuditRowOrgIds(orgBId, OVERLAP_EXPIRED)
      expect(auditRowsA.every((id) => id === orgAId)).toBe(true)
      expect(auditRowsB.every((id) => id === orgBId)).toBe(true)
    })
  }, 20_000)

  // ---------------------------------------------------------------------------------------
  // Story 5.5 AC-9: an audit-write failure for one org/row must roll back only that row and
  // never abort the rest of the same job run.
  // ---------------------------------------------------------------------------------------

  it('AC-9: an audit-write failure for one org rolls back only that org, and other orgs are still processed in the same run', async () => {
    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const projectAId = await seedProject(orgAId)
      const projectBId = await seedProject(orgBId)
      const credentialAId = await seedCredential(orgAId, projectAId)
      const credentialBId = await seedCredential(orgBId, projectBId)
      const versionAId = await seedOverlappingVersion(
        orgAId,
        credentialAId,
        1,
        new Date(Date.now() - 1000)
      )
      const versionBId = await seedOverlappingVersion(
        orgBId,
        credentialBId,
        1,
        new Date(Date.now() - 1000)
      )

      const systemAuditRow = await import('../lib/system-audit-row.js')
      const originalWriteSystemAuditRow = systemAuditRow.writeSystemAuditRow
      const spy = vi
        .spyOn(systemAuditRow, 'writeSystemAuditRow')
        .mockImplementation(async (tx, input) => {
          if (input.orgId === orgAId) throw new Error('forced audit failure for org A')
          return originalWriteSystemAuditRow(tx, input)
        })

      try {
        await expect(runBreakGlassOverlapExpiryJob()).resolves.not.toThrow()
      } finally {
        spy.mockRestore()
      }

      // Org A's row rolled back cleanly — still has its overlap fields set, untouched.
      const stateA = await versionState(orgAId, versionAId)
      expect(stateA?.rotationLockedAt).not.toBeNull()
      expect(stateA?.breakGlassOverlapExpiresAt).not.toBeNull()

      // Org B was still processed despite org A's failure in the same run.
      const stateB = await versionState(orgBId, versionBId)
      expect(stateB?.rotationLockedAt).toBeNull()
      expect(stateB?.breakGlassOverlapExpiresAt).toBeNull()

      // Org A retries cleanly on the next run once the forced failure is gone.
      await runBreakGlassOverlapExpiryJob()
      const stateARetried = await versionState(orgAId, versionAId)
      expect(stateARetried?.rotationLockedAt).toBeNull()
      expect(stateARetried?.breakGlassOverlapExpiresAt).toBeNull()
    })
  }, 20_000)
})
