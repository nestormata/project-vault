import { and, eq, isNotNull } from 'drizzle-orm'
import { paymentRecords } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  baseExpiryPayload,
  formatExpiryDate,
  runExpiryAlertJob,
  type WorkerLogger,
} from './expiry-alert-shared.js'

const JOB_NAME = 'payment:expiry-alert'

type PaymentRecordRow = typeof paymentRecords.$inferSelect

export async function runPaymentExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  await runExpiryAlertJob<PaymentRecordRow>(boss, logger, {
    jobName: JOB_NAME,
    templateId: 'payment.expiry',
    assetType: 'payment_record',
    assetLabel: 'payment',
    fetchRows: (orgId) =>
      runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select()
          .from(paymentRecords)
          .where(and(eq(paymentRecords.orgId, orgId), isNotNull(paymentRecords.renewalDate)))
      ),
    getExpiryDate: (row) => row.renewalDate,
    buildPayload: (row, ctx) => ({
      assetId: row.id,
      projectId: row.projectId,
      name: row.name,
      renewalDate: formatExpiryDate(row.renewalDate),
      ...baseExpiryPayload(ctx),
    }),
    updateNotifiedLeadDays: async (tx, rowId, nextNotifiedLeadDays) => {
      await tx
        .update(paymentRecords)
        .set({ notifiedLeadDays: nextNotifiedLeadDays })
        .where(eq(paymentRecords.id, rowId))
    },
  })
}
