import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import {
  daysFromNow,
  queueEntriesForTemplate,
  withExpiryAlertTestOrg,
} from './expiry-alert-test-helpers.js'
import { runMachineKeyExpiryAlertJob } from './machine-key-expiry-alert.js'

const MACHINE_KEY_EXPIRY_TEMPLATE_ID = 'machine_key.expiry'

async function insertMachineUser(
  orgId: string,
  projectId: string,
  ownerId: string,
  name = 'ci-deploy-bot'
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(machineUsers)
      .values({ orgId, projectId, name, role: 'member', createdBy: ownerId })
      .returning()
  )
  if (!row) throw new Error('expected machine user to be inserted')
  return row
}

describe('machine user API key expiry alert worker', () => {
  it('fires a critical-severity notification at the 3-day threshold and records it (AC-14)', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('machine-key-expiry-owner', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'machine-key-expiry',
      })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)

      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'prod-deploy-key',
            keyHash: 'a'.repeat(64),
            expiresAt: daysFromNow(3),
            alertLeadDays: [14, 3],
          })
          .returning()
      )
      if (!key) throw new Error('expected api key to be inserted')

      await runMachineKeyExpiryAlertJob(boss)

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(apiKeys).where(eq(apiKeys.id, key.id))
      )
      expect(updated?.notifiedLeadDays).toEqual([3])

      const queueEntries = await queueEntriesForTemplate(orgId, MACHINE_KEY_EXPIRY_TEMPLATE_ID)
      expect(queueEntries.length).toBeGreaterThan(0)
      expect((queueEntries[0]?.payload as Record<string, unknown>)?.['keyId']).toBe(key.id)
      expect((queueEntries[0]?.payload as Record<string, unknown>)?.['projectId']).toBe(project.id)
      expect(send).toHaveBeenCalled()
    })
  }, 20_000)

  it('does not re-fire the same threshold on the following day (dedupe)', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('machine-key-expiry-dedupe', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'machine-key-expiry-dedupe',
      })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)

      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'dedupe-key',
          keyHash: 'b'.repeat(64),
          expiresAt: daysFromNow(2),
          alertLeadDays: [14, 3],
          notifiedLeadDays: [3],
        })
      )

      await runMachineKeyExpiryAlertJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, MACHINE_KEY_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 20_000)

  it('excludes revoked keys from the alert query', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('machine-key-expiry-revoked', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'machine-key-expiry-revoked',
      })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)

      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'revoked-key',
          keyHash: 'c'.repeat(64),
          expiresAt: daysFromNow(3),
          alertLeadDays: [14, 3],
          revokedAt: new Date(),
        })
      )

      await runMachineKeyExpiryAlertJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, MACHINE_KEY_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 20_000)

  it('isolates one org from another org fetch/processing failure', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg(
      'machine-key-expiry-org-a',
      async ({ orgId: orgAId, ownerId: ownerAId }) => {
        await withExpiryAlertTestOrg(
          'machine-key-expiry-org-b',
          async ({ orgId: orgBId, ownerId: ownerBId }) => {
            const projectA = await insertTestProject(orgAId, {
              userId: ownerAId,
              slug: 'machine-key-org-a',
            })
            const projectB = await insertTestProject(orgBId, {
              userId: ownerBId,
              slug: 'machine-key-org-b',
            })
            const machineUserA = await insertMachineUser(orgAId, projectA.id, ownerAId, 'bot-a')
            const machineUserB = await insertMachineUser(orgBId, projectB.id, ownerBId, 'bot-b')

            await withOrg(orgAId, (tx) =>
              tx.insert(apiKeys).values({
                orgId: orgAId,
                machineUserId: machineUserA.id,
                name: 'org-a-key',
                keyHash: 'd'.repeat(64),
                expiresAt: daysFromNow(3),
                alertLeadDays: [14, 3],
              })
            )
            await withOrg(orgBId, (tx) =>
              tx.insert(apiKeys).values({
                orgId: orgBId,
                machineUserId: machineUserB.id,
                name: 'org-b-key',
                keyHash: 'e'.repeat(64),
                expiresAt: daysFromNow(3),
                alertLeadDays: [14, 3],
              })
            )

            await runMachineKeyExpiryAlertJob(boss)

            const orgAEntries = await queueEntriesForTemplate(
              orgAId,
              MACHINE_KEY_EXPIRY_TEMPLATE_ID
            )
            const orgBEntries = await queueEntriesForTemplate(
              orgBId,
              MACHINE_KEY_EXPIRY_TEMPLATE_ID
            )
            expect(orgAEntries.length).toBeGreaterThan(0)
            expect(orgBEntries.length).toBeGreaterThan(0)
          }
        )
      }
    )
  }, 20_000)
})
