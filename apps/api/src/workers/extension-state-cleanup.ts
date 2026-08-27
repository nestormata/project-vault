import { lt } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { extensionEphemeralState } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import { getAdminDb } from '../lib/db.js'
import { operationalLog } from '../lib/logger.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/** Story 20.8 AC-7 — the pg-boss job name. Slash-separated (`extension-state/cleanup`), NOT
 * colon-separated, per this story's own drift-check finding: `architecture.md`'s documented
 * `{domain}:{action}` "pg-boss Job Naming" convention (and the `session:cleanup` example it
 * cites) does not exist anywhere in this codebase's real, shipped `main.ts` job registrations —
 * every real job (`'mfa/prune-pending'`, `'notification/dlq-cleanup'`, `'audit/retention-prune'`,
 * etc.) uses `{domain}/{action}` instead. This is documentation drift in architecture.md, not a
 * precedent to follow literally. */
export const EXTENSION_STATE_CLEANUP_JOB = 'extension-state/cleanup'

/**
 * Sweeps `extension_ephemeral_state` rows whose TTL has physically expired. Reads never depend on
 * this sweep for correctness — `get()`/`compareAndSwap()`/`compareAndDelete()` already apply a
 * query-time `expires_at > now()` filter (AC-6) — this job only reclaims storage on a 5-minute
 * cron. Logs exactly one structured `info`-level line per run with `{ purgedCount }` — never a
 * key, value, or per-org breakdown (AC-7).
 */
export async function runExtensionStateCleanup(logger?: WorkerLogger): Promise<void> {
  const result = await getAdminDb()
    .delete(extensionEphemeralState)
    .where(lt(extensionEphemeralState.expiresAt, new Date()))
    .returning({ id: extensionEphemeralState.id })

  if (logger) {
    operationalLog(
      logger,
      'info',
      OperationalEvent.EXTENSION_STATE_CLEANUP_RUN,
      'extension-state/cleanup completed',
      { purgedCount: result.length }
    )
  }
}
