import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, auditLogEntries, machineUsers } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { queueEntriesForTemplate, withExpiryAlertTestOrg } from './expiry-alert-test-helpers.js'
import {
  runMachineKeyOverlapAlertJob,
  runMachineKeyOverlapRevokeJob,
} from './machine-key-overlap-revoke.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'

const { initVault } = await import('../modules/vault/key-service.js')

const MACHINE_KEY_EXPIRY_TEMPLATE_ID = 'machine_key.expiry'
const API_KEY_INSERT_FAILED = 'expected api key to be inserted'
const TEST_PASSPHRASE = 'machine-key-overlap-revoke-passphrase'

async function unsealTestVault(): Promise<void> {
  try {
    await initVault({ kmsType: 'passphrase', passphrase: TEST_PASSPHRASE }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}

async function insertMachineUser(orgId: string, projectId: string, ownerId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(machineUsers)
      .values({ orgId, projectId, name: 'ci-deploy-bot', role: 'member', createdBy: ownerId })
      .returning()
  )
  if (!row) throw new Error('expected machine user to be inserted')
  return row
}

describe.sequential('machine key overlap-revoke job (AC-18)', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    await unsealTestVault()
  })

  afterAll(async () => {
    await resetVaultForTest()
  })

  it('revokes a key whose overlap window has passed and writes a system-actor audit row', async () => {
    await withExpiryAlertTestOrg('overlap-revoke-past', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'overlap-past' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'old-key',
            keyHash: 'a'.repeat(64),
            overlapExpiresAt: new Date(Date.now() - 1000),
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyOverlapRevokeJob()

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, key.id))
      )
      expect(updated?.revokedAt).not.toBeNull()

      const auditRows = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(eq(auditLogEntries.eventType, 'machine_user.api_key_revoked'))
      )
      const row = auditRows.find((r) => r.resourceId === key.id)
      expect(row).toBeDefined()
      expect(row?.actorType).toBe('system')
      expect(row?.actorTokenId).toBeNull()
      expect(row?.payload).toMatchObject({ reason: 'overlap_window_expired', oldKeyId: key.id })
    })
  }, 20_000)

  it('does not revoke a key whose overlap window has not yet passed', async () => {
    await withExpiryAlertTestOrg('overlap-revoke-future', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'overlap-future' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'future-key',
            keyHash: 'b'.repeat(64),
            overlapExpiresAt: new Date(Date.now() + 3_600_000),
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyOverlapRevokeJob()

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, key.id))
      )
      expect(updated?.revokedAt).toBeNull()
    })
  }, 20_000)

  it('is idempotent when a key was already revoked by the time the job runs', async () => {
    await withExpiryAlertTestOrg('overlap-revoke-idempotent', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'overlap-idem' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const alreadyRevokedAt = new Date(Date.now() - 60_000)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'already-revoked',
            keyHash: 'c'.repeat(64),
            overlapExpiresAt: new Date(Date.now() - 1000),
            revokedAt: alreadyRevokedAt,
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyOverlapRevokeJob()

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, key.id))
      )
      expect(updated?.revokedAt?.getTime()).toBe(alreadyRevokedAt.getTime())
    })
  }, 20_000)
})

describe('machine key overlap pre-revocation alert job (AC-18)', () => {
  it('fires machine_key.expiry with reason rotation_overlap_ending ~1h before overlap ends', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('overlap-alert-fire', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'overlap-alert' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'about-to-expire',
            keyHash: 'd'.repeat(64),
            overlapExpiresAt: new Date(Date.now() + 30 * 60_000),
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyOverlapAlertJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, MACHINE_KEY_EXPIRY_TEMPLATE_ID)
      expect(queueEntries.length).toBeGreaterThan(0)
      expect(queueEntries[0]?.payload).toMatchObject({
        keyId: key.id,
        reason: 'rotation_overlap_ending',
      })

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, key.id))
      )
      expect(updated?.overlapAlertSent).toBe(true)
    })
  }, 20_000)

  it('does not re-fire once overlapAlertSent is already true (dedupe)', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('overlap-alert-dedupe', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'overlap-alert-dedupe',
      })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'dedupe-key',
          keyHash: 'e'.repeat(64),
          overlapExpiresAt: new Date(Date.now() + 30 * 60_000),
          overlapAlertSent: true,
        })
      )

      await runMachineKeyOverlapAlertJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, MACHINE_KEY_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 20_000)

  it('does not fire for a key more than 1 hour from its overlap deadline', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('overlap-alert-toosoon', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'overlap-alert-toosoon',
      })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'far-future-key',
          keyHash: 'f'.repeat(64),
          overlapExpiresAt: new Date(Date.now() + 4 * 3_600_000),
        })
      )

      await runMachineKeyOverlapAlertJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, MACHINE_KEY_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 20_000)
})
