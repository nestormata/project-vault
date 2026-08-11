import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Tx } from '@project-vault/db'
import { OperationalEvent } from '@project-vault/shared'
import { getAdminDb } from '../../lib/db.js'
import { operationalLog, serializeLogError } from '../../lib/logger.js'
import { operationalStatusTokens, type OperationalStatusToken } from '@project-vault/db/schema'

/**
 * Story 1.19 D6: platform-level (not org-scoped) token store for the optional GET /status bearer
 * token — mirrors modules/monitoring/status-page-service.ts's admin-connection point-lookup
 * pattern (ADR-6.3-09 step 1), since there is no org to scope an RLS-restricted connection to.
 */

/** The single "currently active" token, if any (newest un-revoked row). Used both to decide
 * whether token protection is enabled at all (AC-4) and, in the Settings UI, to show its
 * metadata (never the plaintext) to the operator. */
export async function findActiveOperationalStatusToken(): Promise<OperationalStatusToken | null> {
  const [row] = await getAdminDb()
    .select()
    .from(operationalStatusTokens)
    .where(isNull(operationalStatusTokens.revokedAt))
    .orderBy(desc(operationalStatusTokens.createdAt))
    .limit(1)
  return row ?? null
}

/** Point lookup by hash for the GET /status auth check — only matches an un-revoked row, same
 * "missing/wrong/revoked all collapse to the same failure" contract as the public status-page
 * token lookup. */
export async function findActiveOperationalStatusTokenByHash(
  tokenHash: string
): Promise<OperationalStatusToken | null> {
  const [row] = await getAdminDb()
    .select()
    .from(operationalStatusTokens)
    .where(
      and(
        eq(operationalStatusTokens.tokenHash, tokenHash),
        isNull(operationalStatusTokens.revokedAt)
      )
    )
    .limit(1)
  return row ?? null
}

export async function insertOperationalStatusToken(
  tx: Tx,
  input: { tokenHash: string; createdByUserId: string; rotatedFromTokenId?: string }
): Promise<OperationalStatusToken> {
  const [row] = await tx
    .insert(operationalStatusTokens)
    .values({
      tokenHash: input.tokenHash,
      createdByUserId: input.createdByUserId,
      rotatedFromTokenId: input.rotatedFromTokenId,
    })
    .returning()
  if (!row) throw new Error('operational_status_tokens insert returned no row')
  return row
}

export async function revokeOperationalStatusToken(tx: Tx, id: string): Promise<void> {
  await tx
    .update(operationalStatusTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(operationalStatusTokens.id, id), isNull(operationalStatusTokens.revokedAt)))
}

/** Best-effort last-used timestamp update on successful probe auth — never blocks or fails the
 * GET /status response if it errors (AC-3's "failures are isolated" applies here too). Failures
 * are still surfaced via `operationalLog` (warn) rather than silently discarded, matching this
 * codebase's other best-effort background-write conventions (e.g. rotation notification
 * dispatch in modules/rotation/routes.ts). `logger` is optional so existing callers/tests that
 * don't have a request-scoped logger handy keep working. */
export async function touchOperationalStatusTokenLastUsed(
  id: string,
  logger?: Pick<FastifyBaseLogger, 'warn'>
): Promise<void> {
  try {
    await getAdminDb()
      .update(operationalStatusTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(operationalStatusTokens.id, id))
  } catch (err) {
    if (logger) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.STATUS_TOKEN_TOUCH_FAILED,
        'status token last-used touch failed',
        { tokenId: id, err: serializeLogError(err) }
      )
    }
  }
}
