import { randomBytes } from 'node:crypto'
import { and, eq, isNull, ne } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { orgMemberships, userIdentityTokens } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'

export type PseudonymizeResult = {
  alias: string
  pseudonymizedAt: Date
  tokensPseudonymized: number
  otherAffectedOrgCount: number
  otherAffectedOrgIds: string[]
}

// eslint-disable-next-line no-secrets/no-secrets -- Public alias-generation alphabet, not a secret.
const ALIAS_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ALIAS_LENGTH = 8

function generateAlias(): string {
  const bytes = randomBytes(ALIAS_LENGTH)
  let alias = ''
  for (let i = 0; i < ALIAS_LENGTH; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- index is `byte % alphabet.length`.
    alias += ALIAS_ALPHABET[(bytes[i] as number) % ALIAS_ALPHABET.length]
  }
  return `user_${alias}`
}

/**
 * D9 blast-radius lookup — `user_identity_tokens` is platform-level (no `orgId` column at all),
 * but `org_memberships` (the table that actually tells us which OTHER orgs this user belongs to)
 * is RLS-protected to the caller's own org (`org_memberships_isolation`,
 * `org_id = current_setting('app.current_org_id')`). There is no way for an Org A owner's
 * ordinary, RLS-scoped `secureCtx.tx` to see Org B's `org_memberships` rows — this cross-org
 * existence check requires the admin connection (`getAdminDb()`, the Postgres superuser role,
 * which bypasses RLS by Postgres's own semantics), mirroring the same "admin connection strictly
 * for a narrow point lookup, never for writes" pattern already established by
 * `auth/recovery-lookup.ts` and `invitations/lookup.ts` for other pre-org-context queries. No
 * write ever goes through this connection — every mutation below uses the caller-supplied `tx`.
 */
export async function findOtherAffectedOrgIds(
  targetUserId: string,
  callerOrgId: string
): Promise<string[]> {
  const rows = await getAdminDb()
    .selectDistinct({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, targetUserId), ne(orgMemberships.orgId, callerOrgId)))
  return rows.map((row) => row.orgId)
}

/**
 * Task 6.1 — the core pseudonymize mutation. Callable both from this story's HTTP route and,
 * per the Epic Cross-Story Context forward dependency, internally from within Story 8.4's own
 * erasure-flow transaction — takes a plain `tx` and already-validated IDs, no
 * `SecureRouteContext`/`ctx.auth` dependency, so a future caller never needs to fabricate one.
 *
 * D8 — idempotent re-pseudonymization: if ANY of this user's `user_identity_tokens` rows already
 * has `pseudonymizedAt` set, this is a no-op that returns the existing alias/timestamp unchanged
 * and issues no `UPDATE` at all (never attempting to work around `prevent_pseudonym_reversal()`,
 * the trigger that would reject a differing `display_name` on an already-pseudonymized row).
 */
export async function pseudonymizeUser(
  tx: Tx,
  params: { targetUserId: string; callerOrgId: string }
): Promise<PseudonymizeResult> {
  const otherAffectedOrgIds = await findOtherAffectedOrgIds(params.targetUserId, params.callerOrgId)

  const existingTokens = await tx
    .select({
      id: userIdentityTokens.id,
      displayName: userIdentityTokens.displayName,
      pseudonymizedAt: userIdentityTokens.pseudonymizedAt,
    })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, params.targetUserId))

  const alreadyPseudonymized = existingTokens.find((token) => token.pseudonymizedAt !== null)
  if (alreadyPseudonymized) {
    return {
      alias: alreadyPseudonymized.displayName,
      pseudonymizedAt: alreadyPseudonymized.pseudonymizedAt as Date,
      tokensPseudonymized: 0,
      otherAffectedOrgCount: otherAffectedOrgIds.length,
      otherAffectedOrgIds,
    }
  }

  const alias = generateAlias()
  const pseudonymizedAt = new Date()
  // AC-17's own edge case — a user with more than one user_identity_tokens row gets BOTH updated
  // to the same alias, not just the "first created" one this codebase's other reads resolve.
  const updated = await tx
    .update(userIdentityTokens)
    .set({ displayName: alias, pseudonymizedAt, updatedAt: pseudonymizedAt })
    .where(
      and(
        eq(userIdentityTokens.userId, params.targetUserId),
        isNull(userIdentityTokens.pseudonymizedAt)
      )
    )
    .returning({ id: userIdentityTokens.id })

  return {
    alias,
    pseudonymizedAt,
    tokensPseudonymized: updated.length,
    otherAffectedOrgCount: otherAffectedOrgIds.length,
    otherAffectedOrgIds,
  }
}
