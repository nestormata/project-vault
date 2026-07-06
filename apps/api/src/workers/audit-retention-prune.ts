import { eq, sql } from 'drizzle-orm'
import { auditRetentionConfig } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { operationalLog } from '../lib/logger.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * D2/AC-23 — the daily retention-pruning cron. For every org WITH a retentionDays configured
 * (org B in AC-23's example, no config row at all, is skipped entirely — no config means no
 * pruning, matching D7's "never silently delete data a feature was never configured for"),
 * calls the SECURITY DEFINER `purge_expired_audit_log_entries()` function inside a matching
 * RLS-scoped transaction — never a raw Drizzle `.delete()` against `auditLogEntries`, which
 * Story 8.1's append-only trigger + grant REVOKE would reject anyway.
 */
export async function pruneExpiredAuditLogEntries(logger?: WorkerLogger): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    try {
      await runOrgScopedJob(orgId, 'audit/retention-prune', async ({ tx }) => {
        const [config] = await tx
          .select({ retentionDays: auditRetentionConfig.retentionDays })
          .from(auditRetentionConfig)
          .where(eq(auditRetentionConfig.orgId, orgId))
          .limit(1)
        if (!config || config.retentionDays === null) return

        const cutoff = new Date(Date.now() - config.retentionDays * MS_PER_DAY)
        const rows = await tx.execute(
          sql`SELECT purge_expired_audit_log_entries(${orgId}::uuid, ${cutoff.toISOString()}::timestamptz) AS deleted`
        )
        const deleted = Number((rows as unknown as { deleted: string }[])[0]?.deleted ?? 0)

        if (logger && deleted > 0) {
          operationalLog(
            logger,
            'info',
            OperationalEvent.AUDIT_RETENTION_PRUNE_SUMMARY,
            'Audit retention prune summary',
            { orgId, retentionDays: config.retentionDays, deleted }
          )
        }
      })
    } catch (error) {
      // One org's failure must never block every other org's prune from running.
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.AUDIT_RETENTION_PRUNE_ROW_FAILED,
          'Audit retention prune failed for an org',
          { orgId, err: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
}
