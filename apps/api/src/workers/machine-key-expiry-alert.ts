import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'
import { runOrgScopedJob } from '../middleware/rls.js'
import {
  baseExpiryPayload,
  formatExpiryDate,
  runExpiryAlertJob,
  type WorkerLogger,
} from './expiry-alert-shared.js'

const JOB_NAME = 'machine-key:expiry-alert'

type MachineKeyExpiryRow = {
  id: string
  projectId: string
  alertLeadDays: number[]
  notifiedLeadDays: number[]
  name: string
  expiresAt: Date | null
  machineUserName: string
}

// Story 7.1 AC-14/D6 — reuses the shared expiry-alert runner verbatim (see cert-expiry-alert.ts
// for the identical shape). The row type needs `projectId`, which lives on `machine_users` not
// `api_keys`, hence the join. Revoked keys are excluded — their owner should not be alerted about
// an "expiring soon" credential that is already dead.
export async function runMachineKeyExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  await runExpiryAlertJob<MachineKeyExpiryRow>(boss, logger, {
    jobName: JOB_NAME,
    templateId: 'machine_key.expiry',
    assetType: 'machine_key',
    assetLabel: 'machine user API key',
    fetchRows: (orgId) =>
      runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select({
            id: apiKeys.id,
            projectId: machineUsers.projectId,
            alertLeadDays: apiKeys.alertLeadDays,
            notifiedLeadDays: apiKeys.notifiedLeadDays,
            name: apiKeys.name,
            expiresAt: apiKeys.expiresAt,
            machineUserName: machineUsers.name,
          })
          .from(apiKeys)
          .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
          .where(
            and(eq(apiKeys.orgId, orgId), isNotNull(apiKeys.expiresAt), isNull(apiKeys.revokedAt))
          )
      ),
    getExpiryDate: (row) => row.expiresAt,
    buildPayload: (row, ctx) => ({
      keyId: row.id,
      keyName: row.name,
      machineUserName: row.machineUserName,
      projectId: row.projectId,
      expiresAt: formatExpiryDate(row.expiresAt),
      ...baseExpiryPayload(ctx),
    }),
    updateNotifiedLeadDays: async (tx, rowId, nextNotifiedLeadDays) => {
      await tx
        .update(apiKeys)
        .set({ notifiedLeadDays: nextNotifiedLeadDays })
        .where(eq(apiKeys.id, rowId))
    },
  })
}
