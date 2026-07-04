import { and, eq, isNotNull } from 'drizzle-orm'
import { certRecords } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  baseExpiryPayload,
  formatExpiryDate,
  runExpiryAlertJob,
  type WorkerLogger,
} from './expiry-alert-shared.js'

const JOB_NAME = 'cert:expiry-alert'

type CertRecordRow = typeof certRecords.$inferSelect

export async function runCertExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  await runExpiryAlertJob<CertRecordRow>(boss, logger, {
    jobName: JOB_NAME,
    templateId: 'certificate.expiry',
    assetType: 'certificate',
    assetLabel: 'certificate',
    fetchRows: (orgId) =>
      runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select()
          .from(certRecords)
          .where(and(eq(certRecords.orgId, orgId), isNotNull(certRecords.expiresAt)))
      ),
    getExpiryDate: (row) => row.expiresAt,
    buildPayload: (row, ctx) => ({
      assetId: row.id,
      projectId: row.projectId,
      domain: row.domain,
      expiresAt: formatExpiryDate(row.expiresAt),
      ...baseExpiryPayload(ctx),
    }),
    updateNotifiedLeadDays: async (tx, rowId, nextNotifiedLeadDays) => {
      await tx
        .update(certRecords)
        .set({ notifiedLeadDays: nextNotifiedLeadDays })
        .where(eq(certRecords.id, rowId))
    },
  })
}
