import { randomBytes, createHmac } from 'node:crypto'
import { and, count, desc, eq, ne } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  accountRecoveryTokens,
  auditLogEntries,
  dataErasureRequests,
  mfaEnrollments,
  mfaRecoveryCodes,
  orgMemberships,
  sessions,
  userIdentityTokens,
  users,
  type DataErasureRequest,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { getAdminDb } from '../../lib/db.js'
import { isUniqueViolation } from '../credentials/db-helpers.js'
import { hashUserPassword } from '../auth/password.js'
import { normalizeEmail } from '../auth/normalize.js'
import { revokeAllUserSessionsInOrg } from '../auth/session-revoke.js'
import { pseudonymizeUserIdentityToken } from './pseudonymize-identity.js'

export type PiiInventoryTable = { table: string; rowCount: number; piiFields: string[] }
export type PiiInventory = { tables: PiiInventoryTable[] }

const ROWS_DELETED_METHOD = 'rows deleted'

const TABLES_ERASED = [
  'users',
  'user_identity_tokens',
  'mfa_enrollments',
  'mfa_recovery_codes',
  'account_recovery_tokens',
  'sessions',
] as const

/** `completed_at` is always set atomically alongside `status = 'completed'` (step 8), so a
 * completed row's `completedAt` is never actually null — this asserts that invariant explicitly
 * (throwing if it's ever violated) instead of a silent non-null assertion. */
function assertCompletedAt(value: Date | null, context: string): Date {
  if (!value) {
    throw new Error(`erasure-service: expected completedAt to be set (${context})`)
  }
  return value
}

/**
 * D6: keyed HMAC-SHA256 (never a bare digest — a plain hash of a low-entropy email is
 * brute-forceable) using a secret dedicated to this purpose (never the Story 8.1 audit-log HMAC
 * key, whose rotation lifecycle is scoped to audit integrity, not this unrelated re-invite guard).
 */
export function hashOriginalEmail(email: string): string {
  return createHmac('sha256', env.ERASURE_EMAIL_HASH_SECRET)
    .update(normalizeEmail(email))
    .digest('hex')
}

/**
 * AC-3: tenant-isolation-safe lookup — a single join query across users/org_memberships scoped
 * to orgId, so "userId doesn't exist at all" and "userId exists but isn't a member of this org"
 * resolve through the identical code/query path and aren't distinguishable by response timing.
 */
export async function findUserInOrg(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<{ id: string; email: string } | null> {
  const [row] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(orgMemberships, eq(orgMemberships.userId, users.id))
    .where(and(eq(users.id, userId), eq(orgMemberships.orgId, orgId)))
    .limit(1)
  return row ?? null
}

/** Extracts the first row's count from a `select({ c: count() })...` result, defaulting to 0.
 * Pulled out of `computePiiInventory` so that function's own cyclomatic complexity doesn't
 * accumulate one branch per table (this repo's eslint `complexity` rule caps at 10). */
function firstCount(rows: { c: number | string }[]): number {
  return Number(rows[0]?.c ?? 0)
}

/** AC-1: PII inventory across every table with erasable PII for a user, scoped to this org where
 * the table itself is org-scoped (sessions) — matches what execution will actually touch. */
export async function computePiiInventory(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<PiiInventory> {
  const [userRows, identityRows, mfaRows, recoveryCodeRows, recoveryTokenRows, sessionRows] =
    await Promise.all([
      tx.select({ c: count() }).from(users).where(eq(users.id, userId)),
      tx
        .select({ c: count() })
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.userId, userId)),
      tx.select({ c: count() }).from(mfaEnrollments).where(eq(mfaEnrollments.userId, userId)),
      tx.select({ c: count() }).from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId)),
      tx
        .select({ c: count() })
        .from(accountRecoveryTokens)
        .where(eq(accountRecoveryTokens.userId, userId)),
      tx
        .select({ c: count() })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.orgId, orgId))),
    ])

  return {
    tables: [
      { table: 'users', rowCount: firstCount(userRows), piiFields: ['email', 'passwordHash'] },
      {
        table: 'user_identity_tokens',
        rowCount: firstCount(identityRows),
        piiFields: ['displayName'],
      },
      {
        table: 'mfa_enrollments',
        rowCount: firstCount(mfaRows),
        piiFields: ['secretEncrypted'],
      },
      {
        table: 'mfa_recovery_codes',
        rowCount: firstCount(recoveryCodeRows),
        piiFields: ['codeHash'],
      },
      {
        table: 'account_recovery_tokens',
        rowCount: firstCount(recoveryTokenRows),
        piiFields: ['tokenHash'],
      },
      {
        table: 'sessions',
        rowCount: firstCount(sessionRows),
        piiFields: ['ipAddress', 'userAgent'],
      },
    ],
  }
}

export type CreateErasureRequestOutcome =
  | { code: 'user_not_found' }
  | { code: 'already_pending'; requestId: string; inventory: PiiInventory }
  | { code: 'already_completed'; requestId: string; completedAt: Date }
  | { code: 'execution_in_progress'; requestId: string }
  | { code: 'created'; requestId: string; inventory: PiiInventory }
  // Defensive fallback for the documented cross-org side-channel edge case (D9's partial unique
  // index is user-scoped, not org-scoped — a unique-violation can come from a row this org's RLS
  // context cannot itself SELECT). Never fabricates details about a row this org can't see.
  | { code: 'conflict' }

async function existingRequestOutcome(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<CreateErasureRequestOutcome | null> {
  const [existing] = await tx
    .select()
    .from(dataErasureRequests)
    .where(and(eq(dataErasureRequests.orgId, orgId), eq(dataErasureRequests.userId, userId)))
    .orderBy(desc(dataErasureRequests.createdAt))
    .limit(1)
  if (!existing) return null
  if (existing.status === 'completed') {
    return {
      code: 'already_completed',
      requestId: existing.id,
      completedAt: assertCompletedAt(existing.completedAt, 'existingRequestOutcome'),
    }
  }
  if (existing.status === 'in_progress') {
    return { code: 'execution_in_progress', requestId: existing.id }
  }
  const inventory = await computePiiInventory(tx, orgId, userId)
  return { code: 'already_pending', requestId: existing.id, inventory }
}

/**
 * AC-1/AC-2/AC-3/AC-4: creates (or returns the existing) erasure request, computing the PII
 * inventory fresh either way.
 *
 * Deliberately does NOT write the D10 `user.erasure_requested` audit event itself — this
 * repo's route-audit.test.ts statically requires that a route classified with
 * `sameTransactionAuditService` calls that service function directly in the *route* file's own
 * source text (not a sibling service module), so the caller (erasure-routes.ts) writes the audit
 * entry itself, in the same transaction, immediately after this returns `'created'`.
 */
export async function createErasureRequest(
  tx: Tx,
  input: {
    orgId: string
    userId: string
    requestedBy: string
    reason: string
  }
): Promise<CreateErasureRequestOutcome> {
  const target = await findUserInOrg(tx, input.orgId, input.userId)
  if (!target) return { code: 'user_not_found' }

  const existing = await existingRequestOutcome(tx, input.orgId, input.userId)
  if (existing) return existing

  const originalEmailHash = hashOriginalEmail(target.email)
  try {
    // D9: nested (SAVEPOINT-backed) transaction — same pattern as rotation/service.ts's
    // initiateRotation. A unique-violation on the partial index aborts only this savepoint, not
    // the outer transaction, so the fallback lookup below (on the still-valid outer `tx`) can run.
    const inserted = await tx.transaction(async (trx) => {
      const [row] = await trx
        .insert(dataErasureRequests)
        .values({
          orgId: input.orgId,
          userId: input.userId,
          requestedBy: input.requestedBy,
          reason: input.reason,
          originalEmailHash,
        })
        .returning()
      if (!row) throw new Error('createErasureRequest: insert returned no row')
      return row
    })

    const inventory = await computePiiInventory(tx, input.orgId, input.userId)
    return { code: 'created', requestId: inserted.id, inventory }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await existingRequestOutcome(tx, input.orgId, input.userId)
      return winner ?? { code: 'conflict' }
    }
    throw error
  }
}

/**
 * D2 CRITICAL: `org_memberships` carries RLS scoped to `app.current_org_id` (the calling org),
 * so a query through the caller's own transaction can only ever see rows in that one org — it is
 * structurally incapable of answering "does this user belong to any OTHER org" (it would always
 * read back 0, silently defeating the entire cross-org guard). This is the same
 * legitimate-cross-org-lookup exception already established for pre-org-context lookups (e.g.
 * `findRecoveryTokenByHash` in `modules/auth/recovery-lookup.ts`): a read-only query via the
 * admin/superuser connection, never used for writes (the actual mutation stays on secureCtx.tx).
 */
async function countOtherOrgMemberships(userId: string, excludeOrgId: string): Promise<number> {
  const [row] = await getAdminDb()
    .select({ c: count() })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), ne(orgMemberships.orgId, excludeOrgId)))
  return Number(row?.c ?? 0)
}

/** D13: freshly-generated, per-user random, non-functional bcrypt/argon2-shaped sentinel — never
 * a fixed shared constant (which would let anyone with DB read access fingerprint every erased
 * account with one `WHERE password_hash = :sentinel` query). */
async function generateSentinelPasswordHash(): Promise<string> {
  return hashUserPassword(randomBytes(32).toString('hex'))
}

function generateErasedEmail(): string {
  return `erased_${randomBytes(6).toString('hex')}@erased.invalid`
}

/** Exported so erasure-routes.ts can look up the audit row's id AFTER writing it directly
 * (route-audit.test.ts requires the audit-write call site itself to live in the route file). */
export async function findLatestAuditEventId(
  tx: Tx,
  input: { orgId: string; eventType: string; resourceId: string }
): Promise<string | null> {
  const [row] = await tx
    .select({ id: auditLogEntries.id })
    .from(auditLogEntries)
    .where(
      and(
        eq(auditLogEntries.orgId, input.orgId),
        eq(auditLogEntries.eventType, input.eventType),
        eq(auditLogEntries.resourceId, input.resourceId)
      )
    )
    .orderBy(desc(auditLogEntries.createdAt))
    .limit(1)
  return row?.id ?? null
}

export type ExecuteErasureOutcome =
  | { code: 'not_found' }
  | { code: 'user_has_other_org_memberships'; otherOrgCount: number }
  | { code: 'already_completed'; completedAt: Date }
  | { code: 'erasure_already_in_progress' }
  | {
      code: 'completed'
      userId: string
      completedAt: Date
      revokedSessionCount: number
      tablesErased: string[]
    }

/**
 * AC-5 through AC-13: the 9-step erasure execution, run entirely inside the caller's
 * transaction (secureRoute wraps the whole request in one). D2's cross-org guard runs BEFORE
 * the D9 compare-and-set claim, so a blocked attempt performs zero mutation, including not
 * claiming `in_progress`.
 *
 * Steps 1-8 only — deliberately does NOT write the D10 `user.erasure_executed` audit event
 * itself (step 9). Same reasoning as `createErasureRequest`: route-audit.test.ts requires the
 * audit-write call site to live directly in erasure-routes.ts, which writes it (still inside
 * this same transaction) immediately after this returns `'completed'`.
 */
export async function executeErasure(
  tx: Tx,
  input: { requestId: string; orgId: string; actorUserId: string }
): Promise<ExecuteErasureOutcome> {
  const [existing] = await tx
    .select()
    .from(dataErasureRequests)
    .where(
      and(eq(dataErasureRequests.id, input.requestId), eq(dataErasureRequests.orgId, input.orgId))
    )
    .limit(1)
  if (!existing) return { code: 'not_found' }
  if (existing.status === 'completed') {
    return {
      code: 'already_completed',
      completedAt: assertCompletedAt(existing.completedAt, 'executeErasure initial check'),
    }
  }

  // D2 CRITICAL cross-org guard — must run before any state transition or mutation.
  const otherOrgCount = await countOtherOrgMemberships(existing.userId, input.orgId)
  if (otherOrgCount > 0) {
    return { code: 'user_has_other_org_memberships', otherOrgCount }
  }

  // D9 compare-and-set: only one concurrent caller can win this transition. Since the whole
  // execution runs in one transaction that only commits at the very end, this 'in_progress'
  // state is never externally visible to another session — a concurrent racer's own compare-
  // and-set blocks on this row's lock until this transaction commits (or rolls back), then
  // re-evaluates the WHERE clause against the final committed value.
  const claimed = await tx
    .update(dataErasureRequests)
    .set({ status: 'in_progress' })
    .where(
      and(eq(dataErasureRequests.id, input.requestId), eq(dataErasureRequests.status, 'pending'))
    )
    .returning({ id: dataErasureRequests.id })
  if (claimed.length === 0) {
    const [refetched] = await tx
      .select({ status: dataErasureRequests.status, completedAt: dataErasureRequests.completedAt })
      .from(dataErasureRequests)
      .where(eq(dataErasureRequests.id, input.requestId))
      .limit(1)
    if (refetched?.status === 'completed') {
      return {
        code: 'already_completed',
        completedAt: assertCompletedAt(
          refetched.completedAt,
          'executeErasure compare-and-set loser'
        ),
      }
    }
    return { code: 'erasure_already_in_progress' }
  }

  const userId = existing.userId

  // Step 1 (D3): pseudonymize user_identity_tokens.display_name.
  await pseudonymizeUserIdentityToken(tx, userId)

  // Step 2: overwrite users.email (non-reversible, unique per erasure).
  // Step 3 (D13): overwrite users.password_hash with a fresh, per-user random sentinel.
  const sentinelPasswordHash = await generateSentinelPasswordHash()
  await tx
    .update(users)
    .set({
      email: generateErasedEmail(),
      passwordHash: sentinelPasswordHash,
      mfaEnrolledAt: null, // Step 4
    })
    .where(eq(users.id, userId))

  // Step 4 (cont.): delete all mfa_enrollments / mfa_recovery_codes rows.
  await tx.delete(mfaEnrollments).where(eq(mfaEnrollments.userId, userId))
  await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId))

  // Step 5 (D5 gap-fix): delete all account_recovery_tokens rows.
  await tx.delete(accountRecoveryTokens).where(eq(accountRecoveryTokens.userId, userId))

  // Step 6 (D12 gap-fix): null sessions.ip_address/user_agent for ALL of this user's session
  // rows in this org (including historical/revoked ones) — additive to step 7's revocation call.
  await tx
    .update(sessions)
    .set({ ipAddress: null, userAgent: null })
    .where(and(eq(sessions.userId, userId), eq(sessions.orgId, input.orgId)))

  // Step 7 (D4): reuse the tested session-revocation primitive verbatim.
  const { revokedCount: revokedSessionCount } = await revokeAllUserSessionsInOrg({
    userId,
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    reason: 'erasure',
    tx,
  })

  // Step 8: mark the request completed.
  const completedAt = new Date()
  await tx
    .update(dataErasureRequests)
    .set({ status: 'completed', completedAt })
    .where(eq(dataErasureRequests.id, input.requestId))

  // Step 9 (D10) is the caller's responsibility (writeHumanAuditEntryOrFailClosed, called
  // directly from erasure-routes.ts — see this function's doc comment above).
  return {
    code: 'completed',
    userId,
    completedAt,
    revokedSessionCount,
    tablesErased: [...TABLES_ERASED],
  }
}

export type ErasureReportOutcome =
  | { code: 'not_found' }
  | { code: 'not_yet_completed'; status: string }
  | {
      code: 'completed'
      report: {
        requestId: string
        executedAt: string
        piiRemoved: { table: string; fields: string[]; method: string }[]
        piiRetained: { table: string; reason: string }[]
        retentionJustification: string
        auditEventId: string | null
      }
    }

/** AC-14/AC-15: a post-execution-only compliance artifact — not a preview (that's AC-1's
 * inventory). */
export async function buildErasureReport(
  tx: Tx,
  input: { orgId: string; requestId: string }
): Promise<ErasureReportOutcome> {
  const [row] = await tx
    .select()
    .from(dataErasureRequests)
    .where(
      and(eq(dataErasureRequests.id, input.requestId), eq(dataErasureRequests.orgId, input.orgId))
    )
    .limit(1)
  if (!row) return { code: 'not_found' }
  if (row.status !== 'completed') return { code: 'not_yet_completed', status: row.status }

  const auditEventId = await findLatestAuditEventId(tx, {
    orgId: input.orgId,
    eventType: AuditEvent.USER_ERASURE_EXECUTED,
    resourceId: row.userId,
  })

  return {
    code: 'completed',
    report: {
      requestId: row.id,
      executedAt: assertCompletedAt(row.completedAt, 'buildErasureReport').toISOString(),
      piiRemoved: [
        {
          table: 'users',
          fields: ['email', 'passwordHash'],
          method: 'overwritten with sentinel/erased-domain value',
        },
        {
          table: 'user_identity_tokens',
          fields: ['displayName'],
          method: 'replaced with pseudonymous alias',
        },
        { table: 'mfa_enrollments', fields: ['secretEncrypted'], method: ROWS_DELETED_METHOD },
        { table: 'mfa_recovery_codes', fields: ['codeHash'], method: ROWS_DELETED_METHOD },
        { table: 'account_recovery_tokens', fields: ['tokenHash'], method: ROWS_DELETED_METHOD },
        {
          table: 'sessions',
          fields: ['ipAddress', 'userAgent'],
          method: 'nulled in place (rows retained for revocation history, PII columns scrubbed)',
        },
      ],
      piiRetained: [
        {
          table: 'audit_log_entries',
          reason:
            'audit log integrity — tamper-evident log (Story 8.1); identity pseudonymized via user_identity_tokens, not this table',
        },
        {
          table: 'org_memberships',
          reason:
            'referential integrity — role/project history retained; display identity pseudonymized',
        },
        {
          table: 'rotations.initiated_by',
          reason:
            'referential integrity for historical rotation records — FK to users.id, no cascade delete',
        },
        {
          table: 'project_invitations.invited_by',
          reason:
            'referential integrity for historical invitation records — FK to users.id, no cascade delete',
        },
      ],
      retentionJustification: 'audit log integrity',
      auditEventId,
    },
  }
}

// Re-exported so route-level tenant-isolation tests can assert on the concrete type without a
// second import path.
export type { DataErasureRequest }
