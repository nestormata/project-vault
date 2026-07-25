import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialVersions } from '@project-vault/db/schema'
import { auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { initiateRotation, promoteRotation, retireRotation } from '../modules/rotation/service.js'
import { encryptValue } from '../lib/encrypt-value.js'
import {
  findAuditRowOrgIds,
  seedWorkerCredential,
  seedWorkerProject,
  unsealWorkerTestVault,
  withTwoTestOrgs,
} from './worker-test-helpers.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault } = await import('../modules/vault/key-service.js')
const { pruneCredentialVersions } = await import('./prune-credential-versions.js')

const TEST_PASSPHRASE = 'prune-credential-versions-passphrase'
const VERSION_PURGED = 'credential.version_purged'

const seedProject = (orgId: string) => seedWorkerProject(orgId, 'Prune')
const seedCredential = (orgId: string, projectId: string, retentionCount = 3) =>
  seedWorkerCredential(orgId, projectId, 'Prune', retentionCount)

async function seedVersion(
  orgId: string,
  credentialId: string,
  versionNumber: number,
  opts: { rotationLockedAt?: Date; abandonedAt?: Date } = {}
): Promise<string> {
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({
        orgId,
        credentialId,
        versionNumber,
        encryptedValue: {
          version: 1,
          iv: 'a'.repeat(24),
          ciphertext: 'b'.repeat(64),
          tag: 'c'.repeat(32),
        },
        keyVersion: 1,
        rotationLockedAt: opts.rotationLockedAt ?? null,
        abandonedAt: opts.abandonedAt ?? null,
      })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected test version to be inserted')
  return version.id
}

/** Story 5.6 AC-3 tests: unlike seedVersion's dummy fixed ciphertext (fine for prune-job-only
 *  tests that never decrypt), initiateRotation's same-value comparison DOES decrypt the previous
 *  version — so these tests need a genuinely vault-encrypted seed row. */
async function seedRealVersion(
  orgId: string,
  credentialId: string,
  versionNumber: number,
  value: string
): Promise<string> {
  const encryptedValue = await encryptValue(value)
  const [version] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentialVersions)
      .values({
        orgId,
        credentialId,
        versionNumber,
        encryptedValue,
        keyVersion: 1,
        promotedAt: new Date(),
      })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected test version to be inserted')
  return version.id
}

/** Seeds a project + credential, then `versionCount` plain versions (1..N), and runs the prune job. */
async function seedAndPruneVersions(
  orgId: string,
  retentionCount: number,
  versionCount: number
): Promise<string> {
  const projectId = await seedProject(orgId)
  const credentialId = await seedCredential(orgId, projectId, retentionCount)
  for (let n = 1; n <= versionCount; n += 1) await seedVersion(orgId, credentialId, n)
  await pruneCredentialVersions()
  return credentialId
}

async function versionsFor(orgId: string, credentialId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        versionNumber: credentialVersions.versionNumber,
        purgedAt: credentialVersions.purgedAt,
        encryptedValue: credentialVersions.encryptedValue,
        keyVersion: credentialVersions.keyVersion,
      })
      .from(credentialVersions)
      .where(eq(credentialVersions.credentialId, credentialId))
      .orderBy(credentialVersions.versionNumber)
  )
}

describe.sequential('pruneCredentialVersions', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealWorkerTestVault(initVault, TEST_PASSPHRASE)
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  afterEach(async () => {
    process.env['CREDENTIAL_RETENTION_DRY_RUN'] = 'false'
  })

  it('prunes versions beyond retentionCount (default 3): with 5 versions, the oldest 2 are purged', async () => {
    await withTestOrg(async ({ orgId }) => {
      const credentialId = await seedAndPruneVersions(orgId, 3, 5)

      const versions = await versionsFor(orgId, credentialId)
      const purged = versions.filter((v) => v.purgedAt !== null)
      const live = versions.filter((v) => v.purgedAt === null)
      expect(purged.map((v) => v.versionNumber).sort()).toEqual([1, 2])
      expect(live.map((v) => v.versionNumber).sort()).toEqual([3, 4, 5])
      for (const version of purged) {
        expect(version.encryptedValue).toBeNull()
        expect(version.keyVersion).toBeNull()
      }
    })
  }, 20_000)

  it('respects a per-credential retentionCount override (1 keeps only the newest)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const credentialId = await seedAndPruneVersions(orgId, 1, 3)

      const versions = await versionsFor(orgId, credentialId)
      const live = versions.filter((v) => v.purgedAt === null)
      expect(live.map((v) => v.versionNumber)).toEqual([3])
    })
  }, 20_000)

  it('does NOT purge a version with rotation_locked_at set, even beyond the retention window', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId, 1)
      await seedVersion(orgId, credentialId, 1, { rotationLockedAt: new Date() })
      await seedVersion(orgId, credentialId, 2)

      await pruneCredentialVersions()

      const versions = await versionsFor(orgId, credentialId)
      const purged = versions.filter((v) => v.purgedAt !== null)
      expect(purged).toHaveLength(0)
    })
  }, 20_000)

  // Story 5.3 regression: an abandoned version (AC-12/CR5) can have a HIGHER versionNumber than
  // the actual current version (abandonment never renumbers anything), which previously let the
  // abandoned version occupy a retention "keep" slot by rank while the real current version got
  // purged out from under it. The current version must survive regardless of its numeric rank.
  it('never purges the actual current version, even when a higher-numbered version is abandoned (retentionCount=1)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId, 1)
      // v1: old historical version — legitimately eligible for purge under retentionCount=1.
      await seedVersion(orgId, credentialId, 1)
      // v2: the real, live "current" version (never abandoned, never locked) — must survive.
      await seedVersion(orgId, credentialId, 2)
      // v3: a HIGHER-numbered version that was abandoned (e.g. a stale-recovery abandon or a
      // break-glass supersede that ran after v2 became current) — ranking purge-eligibility by
      // versionNumber DESC alone would rank v3 above v2, pushing the real current version (v2)
      // out of the retention window and purging it instead of the abandoned dead-end.
      await seedVersion(orgId, credentialId, 3, { abandonedAt: new Date() })

      await pruneCredentialVersions()

      const versions = await versionsFor(orgId, credentialId)
      const byNumber = new Map(versions.map((v) => [v.versionNumber, v]))
      // v1 (genuinely stale history) is purged — retention still works normally.
      expect(byNumber.get(1)?.purgedAt).not.toBeNull()
      // v2 (the actual current version) must never be purged, regardless of v3's higher number.
      expect(byNumber.get(2)?.purgedAt).toBeNull()
      expect(byNumber.get(2)?.encryptedValue).not.toBeNull()
    })
  }, 20_000)

  it('writes a credential.version_purged audit row per purged version with actorType system', async () => {
    await withTestOrg(async ({ orgId }) => {
      await seedAndPruneVersions(orgId, 1, 3)

      const auditRows = await withOrg(orgId, (tx) =>
        tx
          .select({
            actorType: auditLogEntries.actorType,
            actorTokenId: auditLogEntries.actorTokenId,
            payload: auditLogEntries.payload,
          })
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, VERSION_PURGED))
      )
      expect(auditRows).toHaveLength(2)
      for (const row of auditRows) {
        expect(row.actorType).toBe('system')
        expect(row.actorTokenId).toBeNull()
      }
      const purgedVersionNumbers = auditRows
        .map((row) => (row.payload as { versionNumber?: number }).versionNumber)
        .sort()
      expect(purgedVersionNumbers).toEqual([1, 2])
    })
  }, 20_000)

  it('keep-≥-1 invariant: the single highest non-purged version is never purged', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId, 1)
      await seedVersion(orgId, credentialId, 1)

      await pruneCredentialVersions()

      const versions = await versionsFor(orgId, credentialId)
      expect(versions.filter((v) => v.purgedAt === null)).toHaveLength(1)
    })
  }, 20_000)

  it('attributes each purge audit row to its own org (no cross-attribution)', async () => {
    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const projectAId = await seedProject(orgAId)
      const projectBId = await seedProject(orgBId)
      const credentialAId = await seedCredential(orgAId, projectAId, 1)
      const credentialBId = await seedCredential(orgBId, projectBId, 1)
      await seedVersion(orgAId, credentialAId, 1)
      await seedVersion(orgAId, credentialAId, 2)
      await seedVersion(orgBId, credentialBId, 1)
      await seedVersion(orgBId, credentialBId, 2)

      await pruneCredentialVersions()

      const auditRowsA = await findAuditRowOrgIds(orgAId, VERSION_PURGED)
      const auditRowsB = await findAuditRowOrgIds(orgBId, VERSION_PURGED)
      expect(auditRowsA.every((id) => id === orgAId)).toBe(true)
      expect(auditRowsB.every((id) => id === orgBId)).toBe(true)
    })
  }, 20_000)

  // ---------------------------------------------------------------------------------------
  // Story 5.6 AC-3: the FR105 retention exemption now clears only at explicit `retire`, not at
  // `promote` — a promoted-but-unretired version must survive the ordinary retention job
  // indefinitely (the literal reproduction of the sprint-change-proposal's highest-severity
  // Round-3 elicitation finding).
  // ---------------------------------------------------------------------------------------

  it('AC-3.2: a promoted-but-unretired version survives the pruning job at retentionCount=1', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('prune-ac3-promoted')
      try {
        const projectId = await seedProject(orgId)
        const credentialId = await seedCredential(orgId, projectId, 1)
        await seedRealVersion(orgId, credentialId, 1, 'ac3-original-value')
        const initiated = await withOrg(orgId, (tx) =>
          initiateRotation(tx, {
            orgId,
            projectId,
            credentialId,
            userId,
            body: { newValue: 'ac3-new-value', notes: null },
          })
        )
        if (initiated.status !== 'initiated') throw new Error('expected rotation to initiate')

        const promoted = await withOrg(orgId, (tx) =>
          promoteRotation(tx, {
            orgId,
            projectId,
            credentialId,
            rotationId: initiated.rotation.id,
            userId,
            body: { acknowledgedNoDependencies: true },
          })
        )
        if (promoted.outcome !== 'promoted') throw new Error('expected rotation to promote')

        await pruneCredentialVersions()

        const versions = await versionsFor(orgId, credentialId)
        const oldVersion = versions.find((v) => v.versionNumber === 1)
        expect(oldVersion?.purgedAt).toBeNull()
        expect(oldVersion?.encryptedValue).not.toBeNull()
      } finally {
        await deleteTestUser(userId)
      }
    })
  }, 20_000)

  it('AC-3.3: after retire, the old version is already purged and the pruning job is a safe no-op', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('prune-ac3-retired')
      try {
        const projectId = await seedProject(orgId)
        const credentialId = await seedCredential(orgId, projectId, 1)
        await seedRealVersion(orgId, credentialId, 1, 'ac3-original-value')
        const initiated = await withOrg(orgId, (tx) =>
          initiateRotation(tx, {
            orgId,
            projectId,
            credentialId,
            userId,
            body: { newValue: 'ac3-new-value-2', notes: null },
          })
        )
        if (initiated.status !== 'initiated') throw new Error('expected rotation to initiate')

        const promoted = await withOrg(orgId, (tx) =>
          promoteRotation(tx, {
            orgId,
            projectId,
            credentialId,
            rotationId: initiated.rotation.id,
            userId,
            body: { acknowledgedNoDependencies: true },
          })
        )
        if (promoted.outcome !== 'promoted') throw new Error('expected rotation to promote')

        const retired = await withOrg(orgId, (tx) =>
          retireRotation(tx, {
            orgId,
            projectId,
            credentialId,
            rotationId: initiated.rotation.id,
            userId,
            body: { acknowledgedNoDependencies: true },
          })
        )
        if (retired.outcome !== 'retired') throw new Error('expected rotation to retire')

        const versionsBeforePrune = await versionsFor(orgId, credentialId)
        const oldVersionBefore = versionsBeforePrune.find((v) => v.versionNumber === 1)
        expect(oldVersionBefore?.purgedAt).not.toBeNull()

        // Idempotent double-purge guard (AC-3.3/AC-5.3): re-running the pruning job against an
        // already-purged version must be a safe no-op, not an error.
        await expect(pruneCredentialVersions()).resolves.not.toThrow()

        const versionsAfterPrune = await versionsFor(orgId, credentialId)
        const oldVersionAfter = versionsAfterPrune.find((v) => v.versionNumber === 1)
        expect(oldVersionAfter?.purgedAt?.getTime()).toBe(oldVersionBefore?.purgedAt?.getTime())
      } finally {
        await deleteTestUser(userId)
      }
    })
  }, 20_000)

  it('dry-run mode mutates nothing and logs versionsWouldPurge', async () => {
    process.env['CREDENTIAL_RETENTION_DRY_RUN'] = 'true'
    const { env } = await import('../config/env.js')
    const original = env.CREDENTIAL_RETENTION_DRY_RUN
    Object.assign(env, { CREDENTIAL_RETENTION_DRY_RUN: true })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedProject(orgId)
        const credentialId = await seedCredential(orgId, projectId, 1)
        for (let n = 1; n <= 3; n += 1) await seedVersion(orgId, credentialId, n)

        await pruneCredentialVersions(logger)

        const versions = await versionsFor(orgId, credentialId)
        expect(versions.every((v) => v.purgedAt === null)).toBe(true)
        expect(versions.every((v) => v.encryptedValue !== null)).toBe(true)
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'credential.retention.dry_run',
            orgId,
            credentialId,
            versionNumber: 1,
          }),
          'credential retention dry-run candidate'
        )
        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'credential.retention.dry_run',
            orgId,
            versionsWouldPurge: 2,
          }),
          'credential retention dry-run summary'
        )
      })
    } finally {
      Object.assign(env, { CREDENTIAL_RETENTION_DRY_RUN: original })
    }
  }, 20_000)
})
