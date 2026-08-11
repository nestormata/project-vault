import type { FastifyRequest, FastifyBaseLogger } from 'fastify'
import { sql } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { PlatformAuditAction } from '@project-vault/shared'
import { writePlatformAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { generateOperationalStatusToken, hashOperationalStatusToken } from '../status/token.js'
import {
  findActiveOperationalStatusToken,
  insertOperationalStatusToken,
  revokeOperationalStatusToken,
} from '../status/token-store.js'
import { deriveAggregateStatus, runStatusChecks, type DbPool } from '../status/service.js'

/** Concurrency fix (AC-9): `findActiveOperationalStatusToken()` reads via `getAdminDb()` — a
 * connection outside this transaction — so, without serialization, two concurrent
 * generate/rotate calls can both observe the same "existing" active token, both revoke it
 * (idempotent), and both insert a brand-new un-revoked row: two "active" tokens at once, which
 * breaks the "exactly one active token" invariant the rest of this module (and the GET /status
 * auth lookup) assumes. Migration 0069 added a DB-level partial unique index
 * (`uq_operational_status_tokens_single_active`) as a backstop, but that only turns the race into
 * a `23505` error rather than preventing the wasted work/inconsistent read — so this is also
 * closed at the app level with a transaction-scoped advisory lock, same pattern as
 * `lib/rotation-locks.ts` (ADR-5.1-01/5.2-01): a *blocking* `pg_advisory_xact_lock` on a fixed key
 * serializes every generate/rotate/revoke call against each other. The loser simply waits for the
 * winner's transaction to commit (no error, no retry logic needed) and then re-reads a
 * now-consistent "existing active token" view. */
async function acquireStatusTokenLock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('status-token', 0))`)
}

export type StatusTokenMetadata = {
  configured: boolean
  createdAt?: string
  lastUsedAt?: string
}

export async function getStatusTokenMetadata(): Promise<StatusTokenMetadata> {
  const active = await findActiveOperationalStatusToken()
  if (!active) return { configured: false }
  return {
    configured: true,
    createdAt: active.createdAt.toISOString(),
    lastUsedAt: active.lastUsedAt?.toISOString(),
  }
}

/** AC-5/AC-6: generates a brand-new token, revoking any prior active one in the same
 * transaction (a "generate" while a token already exists behaves like rotate — there is only
 * ever one active token). Returns the plaintext once; only the hash is persisted. */
async function generateOrRotateStatusToken(
  operatorUserId: string,
  request: FastifyRequest
): Promise<{ plaintext: string; createdAt: string }> {
  const plaintext = generateOperationalStatusToken()
  const tokenHash = hashOperationalStatusToken(plaintext)

  const createdAt = await getDb().transaction(async (tx) => {
    await acquireStatusTokenLock(tx)
    const existing = await findActiveOperationalStatusToken()
    if (existing) {
      await revokeOperationalStatusToken(tx, existing.id)
    }
    const row = await insertOperationalStatusToken(tx, {
      tokenHash,
      createdByUserId: operatorUserId,
      rotatedFromTokenId: existing?.id,
    })

    // AC-6: "generate" (no prior active token) and "rotate" (an active token already existed)
    // are two distinct human-facing actions even though they share this same code path —
    // recorded as distinct audit actionTypes so the platform audit trail reads accurately.
    await writePlatformAuditEntryOrFailClosed(tx, {
      operatorId: operatorUserId,
      actionType: existing
        ? PlatformAuditAction.STATUS_TOKEN_ROTATED
        : PlatformAuditAction.STATUS_TOKEN_GENERATED,
      payload: { rotatedFromTokenId: existing?.id ?? null },
      request,
    })

    return row.createdAt.toISOString()
  })

  return { plaintext, createdAt }
}

/** AC-5: "Generate" and "Rotate" are the same operation from the store's point of view (there is
 * only ever one active token) — the UI exposes them as two labeled actions for operator clarity,
 * but both land here and both fail closed against Task audit-write failure identically. */
export const generateStatusToken = generateOrRotateStatusToken
export const rotateStatusToken = generateOrRotateStatusToken

export class NoActiveStatusTokenError extends Error {
  constructor() {
    super('No active status token to revoke')
  }
}

export async function revokeStatusToken(
  operatorUserId: string,
  request: FastifyRequest
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await acquireStatusTokenLock(tx)
    const existing = await findActiveOperationalStatusToken()
    if (!existing) throw new NoActiveStatusTokenError()
    await revokeOperationalStatusToken(tx, existing.id)
    await writePlatformAuditEntryOrFailClosed(tx, {
      operatorId: operatorUserId,
      actionType: PlatformAuditAction.STATUS_TOKEN_REVOKED,
      payload: { revokedTokenId: existing.id },
      request,
    })
  })
}

export type StatusTestResult = {
  status: 'healthy' | 'degraded' | 'unavailable'
  checks: Awaited<ReturnType<typeof runStatusChecks>>
}

/** AC-5: the Settings "Test" action runs the same check logic GET /status uses directly
 * in-process (not a self-HTTP-call — simpler, avoids a loopback network round-trip, and cannot
 * itself be blocked by the very token protection it is testing). */
export async function runStatusTokenTest(
  dbPool: DbPool | undefined,
  logger: FastifyBaseLogger
): Promise<StatusTestResult> {
  const checks = await runStatusChecks(dbPool, logger)
  return { status: deriveAggregateStatus(checks), checks }
}
