import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { getDb } from '@project-vault/db'
import { accountRecoveryTokens, type AccountRecoveryToken } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'

/**
 * The caller's identity/org is unknown until the token is resolved, so a per-org RLS-scoped scan
 * isn't an option here (and the table itself carries no org_id — see the schema comment). This is
 * a single point-lookup by the unique HMAC-hashed token index via the admin connection — the
 * 256-bit token is itself the authorization credential, the same trust model already documented
 * for `findInvitationByTokenHash` (`modules/invitations/lookup.ts`) and for the pre-auth
 * refresh_tokens/pending_mfa_sessions RLS exclusions.
 */
export async function findRecoveryTokenByHash(
  tokenHash: string
): Promise<AccountRecoveryToken | null> {
  const [token] = await getAdminDb()
    .select()
    .from(accountRecoveryTokens)
    .where(eq(accountRecoveryTokens.tokenHash, tokenHash))
    .limit(1)
  return token ?? null
}

export type RecoveryTokenStatusError = {
  code:
    | 'recovery_token_not_found'
    | 'recovery_token_expired'
    | 'recovery_token_used'
    | 'recovery_token_superseded'
  message: string
  statusCode: 404 | 409 | 410
}

/** Canonical status-code taxonomy shared by the peek, mfa/start, and complete endpoints. */
export function validateRecoveryTokenStatus(
  token: AccountRecoveryToken | null
): RecoveryTokenStatusError | null {
  if (!token) {
    return { code: 'recovery_token_not_found', message: 'Recovery link not found', statusCode: 404 }
  }
  if (token.usedAt) {
    return {
      code: 'recovery_token_used',
      message: 'This recovery link has already been used',
      statusCode: 409,
    }
  }
  if (token.supersededAt) {
    return {
      code: 'recovery_token_superseded',
      message: 'This recovery link has been superseded by a newer request',
      statusCode: 410,
    }
  }
  if (token.expiresAt < new Date()) {
    return {
      code: 'recovery_token_expired',
      message: 'This recovery link has expired',
      statusCode: 410,
    }
  }
  return null
}

/**
 * Atomically claims a recovery token inside the caller's transaction via a conditional
 * UPDATE ... RETURNING (AC-13/AC-19) — closes the TOCTOU window between the pre-transaction
 * status check and this point, where a concurrent completion/supersession could otherwise both
 * succeed. Returns null when the token was already claimed/superseded/expired by the time this
 * runs — the caller should treat that as 409 recovery_token_already_used.
 */
export async function claimRecoveryToken(
  tx: Tx,
  tokenId: string
): Promise<AccountRecoveryToken | null> {
  const [claimed] = await tx
    .update(accountRecoveryTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(accountRecoveryTokens.id, tokenId),
        isNull(accountRecoveryTokens.usedAt),
        isNull(accountRecoveryTokens.supersededAt),
        gt(accountRecoveryTokens.expiresAt, new Date())
      )
    )
    .returning()
  return claimed ?? null
}

/**
 * AC-9 step 3 / AC-10: supersedes any prior unused, unexpired recovery token for this user so at
 * most one link is ever simultaneously valid. Runs against the caller's transaction (the admin
 * connection is only used for the pre-org-context point lookup by hash, never for writes).
 */
export async function supersedePriorRecoveryTokens(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(accountRecoveryTokens)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(accountRecoveryTokens.userId, userId),
        isNull(accountRecoveryTokens.usedAt),
        isNull(accountRecoveryTokens.supersededAt),
        gt(accountRecoveryTokens.expiresAt, new Date())
      )
    )
}

/**
 * Story 23.2 AC-6 (pre-staging closed retroactively, not just prospectively): called on every
 * boot whose resolved native-login policy is 'disabled' (native-login-policy.ts). Rows minted
 * *before* the exclusion took effect would otherwise sit redeemable and wait for a break-glass
 * window — an org admin's `POST /org/users/:userId/recovery/send-link` (gate row #10) is itself
 * gated the instant exclusion is active, but a token minted in the window before the restart is
 * unaffected by that gate. Superseding EVERY un-redeemed, unexpired row, across every user, closes
 * that retroactively. Reuses the exact `supersededAt` mechanism `supersedePriorRecoveryTokens`
 * already uses — nothing is deleted, no schema change — so `GET /recovery/:token` and
 * `POST /recovery/:token/complete` refuse with the existing superseded-token response, unchanged.
 * Idempotent: an already-superseded row simply doesn't match the WHERE clause again, so this is
 * safe to run on every disabled boot, not gated behind the same "first boot only" latch the audit
 * fanout uses.
 */
export async function supersedeAllPriorRecoveryTokensForExclusion(): Promise<void> {
  // Uses the ordinary (vault_app) connection, NOT getAdminDb() — the admin role only has read
  // grants on this app-owned table (findRecoveryTokenByHash()'s pre-org-context precedent is a
  // SELECT, not a write). This table carries no org_id / RLS (see the schema comment), so a
  // plain vault_app UPDATE with no org context set is exactly the right connection for a sweep
  // spanning every user across every org.
  await getDb()
    .update(accountRecoveryTokens)
    .set({ supersededAt: new Date() })
    .where(
      and(
        isNull(accountRecoveryTokens.usedAt),
        isNull(accountRecoveryTokens.supersededAt),
        gt(accountRecoveryTokens.expiresAt, new Date())
      )
    )
}
