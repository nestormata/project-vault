import { describe, expect, it, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentials } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import * as dispatcher from '../notifications/dispatcher.js'
import {
  daysFromNow,
  expectNoQueueEntries,
  queueEntriesForTemplate,
  withExpiryAlertTestOrg,
} from './expiry-alert-test-helpers.js'
import { runCredentialExpiryAlertJob } from './credential-expiry-alert.js'

const CREDENTIAL_EXPIRY_TEMPLATE_ID = 'credential.expiry'
const CREDENTIAL_NOT_INSERTED = 'expected credential to be inserted'

async function insertCredential(
  orgId: string,
  ownerId: string,
  projectId: string,
  overrides: Partial<typeof credentials.$inferInsert> & {
    name: string
  }
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentials)
      .values({ orgId, projectId, createdBy: ownerId, ...overrides })
      .returning()
  )
  if (!row) throw new Error(CREDENTIAL_NOT_INSERTED)
  return row
}

async function fetchCredential(orgId: string, rowId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(credentials).where(eq(credentials.id, rowId))
  )
  return row
}

async function countAuditLogEntries(orgId: string) {
  const rows = await withOrg(orgId, (tx) => tx.select().from(auditLogEntries))
  return rows.length
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('credential expiry alert worker', () => {
  it('fires a warning-severity notification at the 7-day threshold and records it without audit writes', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('credential-expiry-owner', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'credential-expiry' })
      const row = await insertCredential(orgId, ownerId, project.id, {
        name: 'Database password',
        expiresAt: daysFromNow(7),
        alertLeadDays: [30, 7, 1],
      })

      await runCredentialExpiryAlertJob(boss)

      const updated = await fetchCredential(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([7])

      const queueEntries = await queueEntriesForTemplate(orgId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(2)
      expect(queueEntries[0]?.payload).toEqual({
        assetId: row.id,
        projectId: project.id,
        name: 'Database password',
        expiresAt: row.expiresAt?.toISOString() ?? null,
        daysRemaining: 7,
        threshold: 7,
        overdue: false,
      })
      expect(send).toHaveBeenCalled()
      expect(await countAuditLogEntries(orgId)).toBe(0)
    })
  }, 60_000)

  it('fires a critical overdue alert once after the positive thresholds already fired', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('credential-expiry-overdue', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'credential-expiry-overdue',
      })
      const row = await insertCredential(orgId, ownerId, project.id, {
        name: 'Legacy API token',
        expiresAt: daysFromNow(-3),
        alertLeadDays: [30, 7, 1],
        notifiedLeadDays: [30, 7, 1],
      })

      await runCredentialExpiryAlertJob(boss)

      const updated = await fetchCredential(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([30, 7, 1, 0])

      const queueEntries = await queueEntriesForTemplate(orgId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(2)
      expect(
        queueEntries.every(
          (entry) =>
            (entry.payload as Record<string, unknown>)['threshold'] === 0 &&
            (entry.payload as Record<string, unknown>)['overdue'] === true
        )
      ).toBe(true)
    })
  }, 60_000)

  it('does not fire when no threshold boundary is crossed', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('credential-expiry-far', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'credential-expiry-far',
      })
      const row = await insertCredential(orgId, ownerId, project.id, {
        name: 'Far future secret',
        expiresAt: daysFromNow(20),
        alertLeadDays: [30, 7, 1],
      })

      await runCredentialExpiryAlertJob(boss)

      const updated = await fetchCredential(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([])
      await expectNoQueueEntries(orgId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
    })
  }, 60_000)

  it('does not re-fire the same threshold when the job runs twice on the same day', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('credential-expiry-dedupe', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'credential-expiry-dedupe',
      })
      await insertCredential(orgId, ownerId, project.id, {
        name: 'CI secret',
        expiresAt: daysFromNow(7),
        alertLeadDays: [30, 7, 1],
      })

      await runCredentialExpiryAlertJob(boss)
      await runCredentialExpiryAlertJob(boss)

      const queueEntries = await queueEntriesForTemplate(orgId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(2)
    })
  }, 60_000)

  it('fires a newly crossed threshold independently of an earlier threshold', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('credential-expiry-next-threshold', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'credential-expiry-next-threshold',
      })
      const row = await insertCredential(orgId, ownerId, project.id, {
        name: 'Next threshold secret',
        expiresAt: daysFromNow(1),
        alertLeadDays: [30, 7, 1],
        notifiedLeadDays: [7],
      })

      await runCredentialExpiryAlertJob(boss)

      const updated = await fetchCredential(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([7, 1])

      const queueEntries = await queueEntriesForTemplate(orgId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
      expect(queueEntries).toHaveLength(2)
      expect(
        queueEntries.every((entry) => (entry.payload as Record<string, unknown>)['threshold'] === 1)
      ).toBe(true)
    })
  }, 60_000)

  it('excludes credentials with null expiresAt from the scan', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('credential-expiry-no-date', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'credential-expiry-no-date',
      })
      await insertCredential(orgId, ownerId, project.id, {
        name: 'No expiry yet',
        expiresAt: null,
      })

      await runCredentialExpiryAlertJob(boss)

      await expectNoQueueEntries(orgId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
    })
  }, 60_000)

  it('logs one row failure without aborting the rest of the org or other orgs, and still writes no audit rows', async () => {
    const { boss } = createMockBoss()
    await boss.start()
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    await withExpiryAlertTestOrg('credential-expiry-org-a', async ({ orgId: orgAId, ownerId }) => {
      await withExpiryAlertTestOrg(
        'credential-expiry-org-b',
        async ({ orgId: orgBId, ownerId: ownerBId }) => {
          const projectA = await insertTestProject(orgAId, {
            userId: ownerId,
            slug: 'credential-expiry-org-a',
          })
          const projectB = await insertTestProject(orgBId, {
            userId: ownerBId,
            slug: 'credential-expiry-org-b',
          })

          const failingRow = await insertCredential(orgAId, ownerId, projectA.id, {
            name: 'Broken secret',
            expiresAt: daysFromNow(7),
            alertLeadDays: [30, 7, 1],
          })
          const successfulOrgARow = await insertCredential(orgAId, ownerId, projectA.id, {
            name: 'Healthy secret',
            expiresAt: daysFromNow(7),
            alertLeadDays: [30, 7, 1],
          })
          const successfulOrgBRow = await insertCredential(orgBId, ownerBId, projectB.id, {
            name: 'Other org secret',
            expiresAt: daysFromNow(7),
            alertLeadDays: [30, 7, 1],
          })

          const original = dispatcher.createOrgAdminNotificationEntries
          vi.spyOn(dispatcher, 'createOrgAdminNotificationEntries').mockImplementation(
            async (options) => {
              if ((options.template.payload['assetId'] as string | undefined) === failingRow.id) {
                throw new Error('simulated row failure')
              }
              return original(options)
            }
          )

          await runCredentialExpiryAlertJob(boss, logger)

          const orgAEntries = await queueEntriesForTemplate(orgAId, CREDENTIAL_EXPIRY_TEMPLATE_ID)
          const orgBEntries = await queueEntriesForTemplate(orgBId, CREDENTIAL_EXPIRY_TEMPLATE_ID)

          expect(
            orgAEntries.some(
              (entry) =>
                (entry.payload as Record<string, unknown>)['assetId'] === successfulOrgARow.id
            )
          ).toBe(true)
          expect(
            orgAEntries.some(
              (entry) => (entry.payload as Record<string, unknown>)['assetId'] === failingRow.id
            )
          ).toBe(false)
          expect(
            orgBEntries.some(
              (entry) =>
                (entry.payload as Record<string, unknown>)['assetId'] === successfulOrgBRow.id
            )
          ).toBe(true)
          expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
              eventType: 'monitoring.expiry_alert_row_failed',
              orgId: orgAId,
              assetType: 'credential',
              assetId: failingRow.id,
            }),
            'credential expiry alert row failed'
          )
          expect(await countAuditLogEntries(orgAId)).toBe(0)
          expect(await countAuditLogEntries(orgBId)).toBe(0)
        }
      )
    })
  }, 60_000)
})
