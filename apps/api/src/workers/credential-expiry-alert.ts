import { and, eq, isNotNull } from 'drizzle-orm'
import { credentials } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  baseExpiryPayload,
  formatExpiryDate,
  runExpiryAlertJob,
  type WorkerLogger,
} from './expiry-alert-shared.js'

const JOB_NAME = 'credential/expiry-alert'

type CredentialRow = typeof credentials.$inferSelect

export async function runCredentialExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  await runExpiryAlertJob<CredentialRow>(boss, logger, {
    jobName: JOB_NAME,
    templateId: 'credential.expiry',
    assetType: 'credential',
    assetLabel: 'credential',
    fetchRows: (orgId) =>
      runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select()
          .from(credentials)
          .where(and(eq(credentials.orgId, orgId), isNotNull(credentials.expiresAt)))
      ),
    getExpiryDate: (row) => row.expiresAt,
    buildPayload: (row, ctx) => ({
      assetId: row.id,
      projectId: row.projectId,
      name: row.name,
      expiresAt: formatExpiryDate(row.expiresAt),
      ...baseExpiryPayload(ctx),
    }),
    updateNotifiedLeadDays: async (tx, rowId, nextNotifiedLeadDays) => {
      await tx
        .update(credentials)
        .set({ notifiedLeadDays: nextNotifiedLeadDays })
        .where(eq(credentials.id, rowId))
    },
  })
}
