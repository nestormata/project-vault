import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { withPlatformOperatorContext } from '@project-vault/db'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const MS_PER_DAY = 24 * 60 * 60 * 1000

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
    const rows = await tx.execute(
      sql`SELECT purge_expired_platform_audit_entries(${cutoff.toISOString()}::timestamptz) AS deleted`
    )
    return Number((rows as unknown as { deleted: string }[])[0]?.deleted ?? 0)
  })

  if (logger && deleted > 0) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.PLATFORM_AUDIT_RETENTION_PRUNE_SUMMARY,
      'Platform audit retention prune summary',
      { retentionDays: env.PLATFORM_AUDIT_RETENTION_DAYS, deleted }
    )
  }
}
