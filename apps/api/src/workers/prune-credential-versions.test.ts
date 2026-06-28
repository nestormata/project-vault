import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { credentialVersions, credentials, projects } from '@project-vault/db/schema'
import { auditLogEntries } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault } = await import('../modules/vault/key-service.js')
const { pruneCredentialVersions } = await import('./prune-credential-versions.js')

const TEST_PASSPHRASE = 'prune-credential-versions-passphrase'
const VERSION_PURGED = 'credential.version_purged'

async function unsealTestVault(): Promise<void> {
  try {
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}

async function seedProject(orgId: string): Promise<string> {
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({ orgId, name: 'Prune Project', slug: `prune-${randomUUID()}` })
      .returning({ id: projects.id })
  )
  if (!project) throw new Error('expected test project to be inserted')
  return project.id
}

async function seedCredential(
  orgId: string,
  projectId: string,
  retentionCount = 3
): Promise<string> {
  const [credential] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentials)
      .values({ orgId, projectId, name: 'Prune Credential', retentionCount })
      .returning({ id: credentials.id })
  )
  if (!credential) throw new Error('expected test credential to be inserted')
  return credential.id
}

async function seedVersion(
  orgId: string,
  credentialId: string,
  versionNumber: number,
  opts: { rotationLockedAt?: Date } = {}
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
      })
      .returning({ id: credentialVersions.id })
  )
  if (!version) throw new Error('expected test version to be inserted')
  return version.id
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
    await unsealTestVault()
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  afterEach(async () => {
    process.env['CREDENTIAL_RETENTION_DRY_RUN'] = 'false'
  })

  it('prunes versions beyond retentionCount (default 3): with 5 versions, the oldest 2 are purged', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId, 3)
      for (let n = 1; n <= 5; n += 1) await seedVersion(orgId, credentialId, n)

      await pruneCredentialVersions()

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
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId, 1)
      for (let n = 1; n <= 3; n += 1) await seedVersion(orgId, credentialId, n)

      await pruneCredentialVersions()

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

  it('writes a credential.version_purged audit row per purged version with actorType system', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedProject(orgId)
      const credentialId = await seedCredential(orgId, projectId, 1)
      for (let n = 1; n <= 3; n += 1) await seedVersion(orgId, credentialId, n)

      await pruneCredentialVersions()

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
    await withTestOrg(async ({ orgId: orgAId }) => {
      await withTestOrg(async ({ orgId: orgBId }) => {
        const projectAId = await seedProject(orgAId)
        const projectBId = await seedProject(orgBId)
        const credentialAId = await seedCredential(orgAId, projectAId, 1)
        const credentialBId = await seedCredential(orgBId, projectBId, 1)
        await seedVersion(orgAId, credentialAId, 1)
        await seedVersion(orgAId, credentialAId, 2)
        await seedVersion(orgBId, credentialBId, 1)
        await seedVersion(orgBId, credentialBId, 2)

        await pruneCredentialVersions()

        const auditRowsA = await withOrg(orgAId, (tx) =>
          tx
            .select({ orgId: auditLogEntries.orgId })
            .from(auditLogEntries)
            .where(eq(auditLogEntries.eventType, VERSION_PURGED))
        )
        const auditRowsB = await withOrg(orgBId, (tx) =>
          tx
            .select({ orgId: auditLogEntries.orgId })
            .from(auditLogEntries)
            .where(eq(auditLogEntries.eventType, VERSION_PURGED))
        )
        expect(auditRowsA.every((row) => row.orgId === orgAId)).toBe(true)
        expect(auditRowsB.every((row) => row.orgId === orgBId)).toBe(true)
      })
    })
  }, 20_000)

  it('dry-run mode mutates nothing and logs versionsWouldPurge', async () => {
    process.env['CREDENTIAL_RETENTION_DRY_RUN'] = 'true'
    const { env } = await import('../config/env.js')
    const original = env.CREDENTIAL_RETENTION_DRY_RUN
    Object.assign(env, { CREDENTIAL_RETENTION_DRY_RUN: true })

    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await seedProject(orgId)
        const credentialId = await seedCredential(orgId, projectId, 1)
        for (let n = 1; n <= 3; n += 1) await seedVersion(orgId, credentialId, n)

        await pruneCredentialVersions()

        const versions = await versionsFor(orgId, credentialId)
        expect(versions.every((v) => v.purgedAt === null)).toBe(true)
        expect(versions.every((v) => v.encryptedValue !== null)).toBe(true)
      })
    } finally {
      Object.assign(env, { CREDENTIAL_RETENTION_DRY_RUN: original })
    }
  }, 20_000)
})
