import { and, eq, isNotNull } from 'drizzle-orm'
import { domainRecords } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  baseExpiryPayload,
  formatExpiryDate,
  runExpiryAlertJob,
  type WorkerLogger,
} from './expiry-alert-shared.js'

const JOB_NAME = 'domain/expiry-alert'

type DomainRecordRow = typeof domainRecords.$inferSelect

export async function runDomainExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  await runExpiryAlertJob<DomainRecordRow>(boss, logger, {
    jobName: JOB_NAME,
    templateId: 'domain.expiry',
    assetType: 'domain_record',
    assetLabel: 'domain',
    fetchRows: (orgId) =>
      runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select()
          .from(domainRecords)
          .where(and(eq(domainRecords.orgId, orgId), isNotNull(domainRecords.renewalDate)))
      ),
    getExpiryDate: (row) => row.renewalDate,
    buildPayload: (row, ctx) => ({
      assetId: row.id,
      projectId: row.projectId,
      domainName: row.domainName,
      renewalDate: formatExpiryDate(row.renewalDate),
      ...baseExpiryPayload(ctx),
    }),
    updateNotifiedLeadDays: async (tx, rowId, nextNotifiedLeadDays) => {
      await tx
        .update(domainRecords)
        .set({ notifiedLeadDays: nextNotifiedLeadDays })
        .where(eq(domainRecords.id, rowId))
    },
  })
}
