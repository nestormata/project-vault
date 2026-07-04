import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { domainRecords } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import {
  daysFromNow,
  expectNoQueueEntries,
  expectQueueEntryFired,
  withExpiryAlertTestOrg,
} from './expiry-alert-test-helpers.js'
import { runDomainExpiryAlertJob } from './domain-expiry-alert.js'

const DOMAIN_EXPIRY_TEMPLATE_ID = 'domain.expiry'
const DOMAIN_RECORD_NOT_INSERTED = 'expected domain record to be inserted'

/** Inserts a domain record for the test org, defaulting createdBy to the seeded owner. */
async function insertDomainRecord(
  orgId: string,
  ownerId: string,
  projectId: string,
  overrides: Partial<typeof domainRecords.$inferInsert> & { domainName: string; renewalDate: Date }
) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(domainRecords)
      .values({ orgId, projectId, createdBy: ownerId, ...overrides })
      .returning()
  )
  if (!row) throw new Error(DOMAIN_RECORD_NOT_INSERTED)
  return row
}

async function fetchDomainRecord(orgId: string, rowId: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(domainRecords).where(eq(domainRecords.id, rowId))
  )
  return row
}

describe('domain expiry alert worker', () => {
  it('fires a deliverable (warning-severity) notification at a 7-day threshold and records it', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('domain-expiry-owner', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'domain-expiry' })
      const row = await insertDomainRecord(orgId, ownerId, project.id, {
        domainName: 'example.com',
        renewalDate: daysFromNow(7),
        alertLeadDays: [30, 7],
      })

      await runDomainExpiryAlertJob(boss)

      const updated = await fetchDomainRecord(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([7])

      await expectQueueEntryFired(orgId, DOMAIN_EXPIRY_TEMPLATE_ID, row.id, send)
    })
  }, 20_000)

  it('does not re-fire the same threshold on the following day', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('domain-expiry-owner-2', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'domain-expiry-dedupe',
      })
      await insertDomainRecord(orgId, ownerId, project.id, {
        domainName: 'dedupe.example.com',
        renewalDate: daysFromNow(6),
        alertLeadDays: [30, 7],
        notifiedLeadDays: [7],
      })

      await runDomainExpiryAlertJob(boss)

      await expectNoQueueEntries(orgId, DOMAIN_EXPIRY_TEMPLATE_ID)
    })
  }, 20_000)

  it('does not fire for a renewal date far outside any configured threshold', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('domain-expiry-owner-3', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'domain-expiry-far',
      })
      await insertDomainRecord(orgId, ownerId, project.id, {
        domainName: 'far-out.example.com',
        renewalDate: daysFromNow(200),
        alertLeadDays: [30],
      })

      await runDomainExpiryAlertJob(boss)

      await expectNoQueueEntries(orgId, DOMAIN_EXPIRY_TEMPLATE_ID)
    })
  }, 20_000)

  it("advances notifiedLeadDays for the default 30-day (info-severity) threshold even though the default admin preference (minSeverity warning) filters the delivery — documents this interaction rather than hiding it; the alert cycle still won't re-fire on day 29", async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('domain-expiry-owner-4', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'domain-expiry-info',
      })

      const row = await insertDomainRecord(orgId, ownerId, project.id, {
        domainName: 'info-severity.example.com',
        renewalDate: daysFromNow(30),
        alertLeadDays: [30],
      })

      await runDomainExpiryAlertJob(boss)

      const updated = await fetchDomainRecord(orgId, row.id)
      expect(updated?.notifiedLeadDays).toEqual([30])

      // Default org-admin preference min severity is 'warning' (Story 3.2); an 'info'-severity
      // alert is correctly filtered at the routing/preference layer — no queue row is created —
      // but the threshold is still consumed so the daily job doesn't keep re-evaluating it.
      await expectNoQueueEntries(orgId, DOMAIN_EXPIRY_TEMPLATE_ID)
    })
  }, 20_000)
})
