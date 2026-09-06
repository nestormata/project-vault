import { eq, gte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent, PlatformAuditAction } from '@project-vault/shared'
import { withPlatformOperatorContext, type Tx } from '@project-vault/db'
import { platformAuditEvents, users } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import { writePlatformAuditEntry } from '../modules/platform-audit/write-entry.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Story 1.25 AC-4: the system-authored tombstone row needs a real `operatorId` (NOT NULL, FK to
 * `users`) — this table has no "system" actor concept the way `audit_log_entries` does. Grepped
 * this repo for an existing precedent (per the story's own instruction) and found none: every
 * current `writePlatformAuditEntry` call site passes a real, authenticated human operator's
 * `auth.userId`. Rather than inventing new seed-user infrastructure for a single system write,
 * this resolves to the instance's own platform operator (`users.is_platform_operator = true`) —
 * a real, already-existing user row that is unique-by-constraint (0038's partial unique index)
 * and, by construction, must already exist by the time any org has audit data old enough to
 * purge (the platform operator is always the very first user any self-hosted instance ever
 * registers). Returns `null` on a fresh/unbootstrapped instance (defensive only — retention
 * pruning finding deletable rows implies a bootstrapped instance already exists).
 */
async function resolvePlatformOperatorId(tx: Tx): Promise<string | null> {
  const [operator] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isPlatformOperator, true))
    .limit(1)
  return operator?.id ?? null
}

/**
 * Story 9.4 AC-17: the daily `platform-audit/retention` cron. Instance-wide (no per-org loop,
 * unlike `pruneExpiredAuditLogEntries` — this table has no tenant scope, D5), calls the
 * SECURITY DEFINER `purge_expired_platform_audit_entries()` function inside a transaction with
 * `app.platform_operator_verified` set (mirrors `runOrgScopedJob`'s RLS-context discipline for
 * the org-scoped equivalent) — never a raw Drizzle `.delete()`, which this table's append-only
 * trigger + grant REVOKE would reject anyway.
 */
export async function prunePlatformAuditEvents(logger?: WorkerLogger): Promise<void> {
  const cutoff = new Date(Date.now() - env.PLATFORM_AUDIT_RETENTION_DAYS * MS_PER_DAY)

  const deleted = await withPlatformOperatorContext(async (tx) => {
    // Story 1.25 AC-4: same capture-before-purge pattern as the org-scoped worker — see that
    // file's comment for the full rationale. No org filter (D11): a single global chain.
    const [survivor] = await tx
      .select({ previousEntryHmac: platformAuditEvents.previousEntryHmac })
      .from(platformAuditEvents)
      .where(gte(platformAuditEvents.createdAt, cutoff))
      .orderBy(platformAuditEvents.chainSeq)
      .limit(1)
    const expectedGapHash = survivor?.previousEntryHmac ?? null

    const rows = await tx.execute(
      sql`SELECT purge_expired_platform_audit_entries(${cutoff.toISOString()}::timestamptz) AS deleted`
    )
    const deletedCount = Number((rows as unknown as { deleted: string }[])[0]?.deleted ?? 0)

    if (deletedCount > 0 && expectedGapHash !== null) {
      const operatorId = await resolvePlatformOperatorId(tx)
      if (operatorId !== null) {
        await writePlatformAuditEntry(tx, {
          operatorId,
          actionType: PlatformAuditAction.RETENTION_PURGE_BOUNDARY,
          payload: {
            retentionDays: env.PLATFORM_AUDIT_RETENTION_DAYS,
            cutoff: cutoff.toISOString(),
            deletedCount,
            attestedGapHash: expectedGapHash,
          },
        })
      } else if (logger) {
        // Defensive-only path (see resolvePlatformOperatorId's doc comment) — an unattested gap
        // is still strictly better than a thrown error that would abort the whole purge
        // transaction and leave already-computed deletions half-applied.
        operationalLog(
          logger,
          'error',
          OperationalEvent.PLATFORM_AUDIT_RETENTION_PRUNE_SUMMARY,
          'Platform audit retention prune: purge boundary tombstone skipped, no platform operator found',
          { deletedCount }
        )
      }
    }

    return deletedCount
  })

  if (logger) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.PLATFORM_AUDIT_RETENTION_PRUNE_SUMMARY,
      'Platform audit retention prune summary',
      { retentionDays: env.PLATFORM_AUDIT_RETENTION_DAYS, deleted }
    )
  }
}
