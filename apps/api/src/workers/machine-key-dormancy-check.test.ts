import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { apiKeys, auditLogEntries, machineUsers, securityAlerts } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { queueEntriesForTemplate, withExpiryAlertTestOrg } from './expiry-alert-test-helpers.js'
import { runMachineKeyDormancyCheckJob } from './machine-key-dormancy-check.js'

const DORMANT_TEMPLATE_ID = 'machine_key.dormant'
const API_KEY_INSERT_FAILED = 'expected api key to be inserted'
const NINETY_ONE_DAYS_AGO = new Date(Date.now() - 91 * 86_400_000)
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000)

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

describe('machine key dormancy check job (AC-21)', () => {
  it('fires machine_key.dormant for a key unused beyond the org threshold (default 90 days)', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-fire', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'dormancy-fire' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'stale-key',
            keyHash: 'a'.repeat(64),
            lastUsedAt: NINETY_ONE_DAYS_AGO,
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyDormancyCheckJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
      expect(queueEntries.length).toBeGreaterThan(0)
      expect(queueEntries[0]?.payload).toMatchObject({ keyId: key.id })

      const alerts = await withOrg(orgId, (tx) =>
        tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
      )
      expect(alerts.length).toBeGreaterThan(0)
    })
  }, 60_000)

  it('does not fire for a key used recently', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-recent', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'dormancy-recent' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'fresh-key',
          keyHash: 'b'.repeat(64),
          lastUsedAt: TEN_DAYS_AGO,
        })
      )

      await runMachineKeyDormancyCheckJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 60_000)

  it('does not re-fire a duplicate alert on a second run (dedupe via partial unique index)', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-dedupe', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'dormancy-dedupe' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'stale-key-dedupe',
            keyHash: 'c'.repeat(64),
            lastUsedAt: NINETY_ONE_DAYS_AGO,
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyDormancyCheckJob(boss)
      await runMachineKeyDormancyCheckJob(boss)

      const alerts = await withOrg(orgId, (tx) =>
        tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
      )
      const matchingAlerts = alerts.filter(
        (a) => (a.payload as Record<string, unknown>)?.['keyId'] === key.id
      )
      expect(matchingAlerts).toHaveLength(1)
    })
  }, 60_000)

  it('excludes a key with an active dormancy snooze', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-snoozed', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'dormancy-snoozed' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'snoozed-key',
          keyHash: 'd'.repeat(64),
          lastUsedAt: NINETY_ONE_DAYS_AGO,
          dormancySnoozedUntil: new Date(Date.now() + 30 * 86_400_000),
        })
      )

      await runMachineKeyDormancyCheckJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 60_000)

  it('excludes a revoked key', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-revoked', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'dormancy-revoked' })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: machineUser.id,
          name: 'revoked-stale-key',
          keyHash: 'e'.repeat(64),
          lastUsedAt: NINETY_ONE_DAYS_AGO,
          revokedAt: new Date(),
        })
      )

      await runMachineKeyDormancyCheckJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(0)
    })
  }, 60_000)

  it('fires for a never-used key whose createdAt is older than the threshold', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-never-used', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'dormancy-never-used',
      })
      const machineUser = await insertMachineUser(orgId, project.id, ownerId)
      const [key] = await withOrg(orgId, (tx) =>
        tx
          .insert(apiKeys)
          .values({
            orgId,
            machineUserId: machineUser.id,
            name: 'never-used-key',
            keyHash: 'f'.repeat(64),
            createdAt: NINETY_ONE_DAYS_AGO,
          })
          .returning()
      )
      if (!key) throw new Error(API_KEY_INSERT_FAILED)

      await runMachineKeyDormancyCheckJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
      expect(queueEntries.length).toBeGreaterThan(0)
    })
  }, 60_000)

  // Story 73.9 AC-4: a host-managed machine user is keyless by construction, so the job never
  // selects, alerts on or modifies it, even when it is older than the threshold.
  it('never touches a host-managed machine user', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('dormancy-host-managed', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'dormancy-hm' })
      const adminProvisioned = await insertMachineUser(orgId, project.id, ownerId)
      await withOrg(orgId, (tx) =>
        tx.insert(apiKeys).values({
          orgId,
          machineUserId: adminProvisioned.id,
          name: 'stale-admin-key',
          keyHash: 'e'.repeat(64),
          lastUsedAt: NINETY_ONE_DAYS_AGO,
        })
      )
      const [hostManaged] = await withOrg(orgId, (tx) =>
        tx
          .insert(machineUsers)
          .values({
            orgId,
            projectId: null,
            name: 'com.centralizeme.module-pack',
            role: 'viewer',
            createdBy: null,
            hostManaged: true,
            createdAt: NINETY_ONE_DAYS_AGO,
          })
          .returning()
      )
      if (!hostManaged) throw new Error('expected host-managed machine user to be inserted')

      await runMachineKeyDormancyCheckJob(boss)

      const alerts = await withOrg(orgId, (tx) =>
        tx.select().from(securityAlerts).where(eq(securityAlerts.alertType, DORMANT_TEMPLATE_ID))
      )
      expect(alerts).toHaveLength(1)
      expect(JSON.stringify(alerts)).not.toContain(hostManaged.id)
      const queueEntries = await queueEntriesForTemplate(orgId, DORMANT_TEMPLATE_ID)
      expect(JSON.stringify(queueEntries)).not.toContain(hostManaged.id)
      const audit = await withOrg(orgId, (tx) => tx.select().from(auditLogEntries))
      expect(JSON.stringify(audit)).not.toContain(hostManaged.id)
      const [after] = await withOrg(orgId, (tx) =>
        tx.select().from(machineUsers).where(eq(machineUsers.id, hostManaged.id))
      )
      expect(after).toEqual(hostManaged)
    })
  }, 60_000)
})
