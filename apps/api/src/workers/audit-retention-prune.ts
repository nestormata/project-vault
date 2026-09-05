import { and, eq, gte, sql } from 'drizzle-orm'
import { auditLogEntries, auditRetentionConfig } from '@project-vault/db/schema'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { operationalLog } from '../lib/logger.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../middleware/rls.js'
import { writeSystemAuditEntry } from '../modules/audit/machine-entry.js'

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

        // Story 1.25 AC-4: capture, BEFORE the purge runs, the hash the gap will orphan — the
        // oldest row that WILL survive the purge (org-scoped, chain_seq order) has its own
        // previous_entry_hmac already pointing at whatever is about to be deleted. This value is
        // exactly what verify.ts's chain-walk will need to recognize as an attested (not
        // tampered) gap once the purge removes the rows that would otherwise satisfy it. If no
        // such row exists, the purge is about to remove this org's ENTIRE history — no gap to
        // attest (the next row this org ever writes will naturally compute a null/genesis
        // previousEntryHmac via the ordinary empty-lookup path).
        const [survivor] = await tx
          .select({ previousEntryHmac: auditLogEntries.previousEntryHmac })
          .from(auditLogEntries)
          .where(and(eq(auditLogEntries.orgId, orgId), gte(auditLogEntries.createdAt, cutoff)))
          .orderBy(auditLogEntries.chainSeq)
          .limit(1)
        const expectedGapHash = survivor?.previousEntryHmac ?? null

        const rows = await tx.execute(
          sql`SELECT purge_expired_audit_log_entries(${orgId}::uuid, ${cutoff.toISOString()}::timestamptz) AS deleted`
        )
        const deleted = Number((rows as unknown as { deleted: string }[])[0]?.deleted ?? 0)

        // Story 1.25 AC-4: the tombstone is an ordinary chained row — its own previous_entry_hmac
        // is computed the normal way (chaining onto the current tail), it has no special chain
        // position. RETENTION_PURGE_BOUNDARY is in QUOTA_REMEDIATION_EVENT_TYPES (quota-gate.ts),
        // so an over-quota org's purge can still record its own tombstone — confirmed directly
        // that assertOrgMayWriteAuditGates would otherwise refuse this write for exactly the org
        // retention pruning exists to relieve.
        if (deleted > 0 && expectedGapHash !== null) {
          await writeSystemAuditEntry(tx, {
            orgId,
            eventType: AuditEvent.RETENTION_PURGE_BOUNDARY,
            payload: {
              retentionDays: config.retentionDays,
              cutoff: cutoff.toISOString(),
              deletedCount: deleted,
              attestedGapHash: expectedGapHash,
            },
          })
        }

        if (logger) {
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
