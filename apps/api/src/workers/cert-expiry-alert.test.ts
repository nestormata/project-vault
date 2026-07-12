import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { certRecords } from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import {
  daysFromNow,
  expectNoQueueEntries,
  expectQueueEntryFired,
  withExpiryAlertTestOrg,
} from './expiry-alert-test-helpers.js'
import { runCertExpiryAlertJob } from './cert-expiry-alert.js'

const CERTIFICATE_EXPIRY_TEMPLATE_ID = 'certificate.expiry'

describe('certificate expiry alert worker', () => {
  it('fires a warning-severity notification at the 7-day threshold and records it', async () => {
    const { boss, send } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('cert-expiry-owner', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'cert-expiry' })

      const [row] = await withOrg(orgId, (tx) =>
        tx
          .insert(certRecords)
          .values({
            orgId,
            projectId: project.id,
            domain: 'api.example.com',
            expiresAt: daysFromNow(7),
            alertLeadDays: [30, 7],
            createdBy: ownerId,
          })
          .returning()
      )
      if (!row) throw new Error('expected cert record to be inserted')

      await runCertExpiryAlertJob(boss)

      const [updated] = await withOrg(orgId, (tx) =>
        tx.select().from(certRecords).where(eq(certRecords.id, row.id))
      )
      expect(updated?.notifiedLeadDays).toEqual([7])

      await expectQueueEntryFired(orgId, CERTIFICATE_EXPIRY_TEMPLATE_ID, row.id, send)
    })
  }, 60_000)

  it('does not re-fire the same threshold on the following day', async () => {
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('cert-expiry-owner-2', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, {
        userId: ownerId,
        slug: 'cert-expiry-dedupe',
      })

      await withOrg(orgId, (tx) =>
        tx.insert(certRecords).values({
          orgId,
          projectId: project.id,
          domain: 'dedupe.example.com',
          expiresAt: daysFromNow(6),
          alertLeadDays: [30, 7],
          notifiedLeadDays: [7],
          createdBy: ownerId,
        })
      )

      await runCertExpiryAlertJob(boss)

      await expectNoQueueEntries(orgId, CERTIFICATE_EXPIRY_TEMPLATE_ID)
    })
  }, 60_000)
})
