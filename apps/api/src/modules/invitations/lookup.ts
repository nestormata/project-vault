import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { projectInvitations, type ProjectInvitation } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'

/**
 * The caller's org is unknown until the invitation is resolved, so a per-org RLS-scoped scan
 * isn't an option here (and would be an unbounded table scan across every org in the vault).
 * This is a single point-lookup by the unique HMAC-hashed token index via the admin connection —
 * the 256-bit token is itself the authorization credential, the same trust model that already
 * excludes refresh_tokens/pending_mfa_sessions from RLS for identical pre-auth lookups. Once the
 * owning org is resolved, all further reads/writes happen inside withOrg()/secureCtx.tx like
 * every other route.
 */
export async function findInvitationByTokenHash(
  tokenHash: string
): Promise<ProjectInvitation | null> {
  const [invitation] = await getAdminDb()
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.tokenHash, tokenHash))
    .limit(1)
  return invitation ?? null
}

export type InvitationStatusError = {
  code:
    | 'invitation_not_found'
    | 'invitation_revoked'
    | 'invitation_already_accepted'
    | 'invitation_expired'
  message: string
  statusCode: 404 | 410 | 409
}

/** Canonical status-code taxonomy shared by the peek, accept, and registration endpoints. */
export function validateInvitationStatus(
  invitation: ProjectInvitation | null
): InvitationStatusError | null {
  if (!invitation) {
    return { code: 'invitation_not_found', message: 'Invitation not found', statusCode: 404 }
  }
  if (invitation.revokedAt) {
    return {
      code: 'invitation_revoked',
      message: 'This invitation has been revoked',
      statusCode: 410,
    }
  }
  if (invitation.acceptedAt) {
    return {
      code: 'invitation_already_accepted',
      message: 'This invitation has already been accepted',
      statusCode: 409,
    }
  }
  if (invitation.expiresAt < new Date()) {
    return { code: 'invitation_expired', message: 'This invitation has expired', statusCode: 410 }
  }
  return null
}

/**
 * Atomically claims an invitation inside the caller's transaction via a conditional
 * UPDATE ... RETURNING. Closes the TOCTOU window between the pre-transaction status check
 * (validateInvitationStatus) and this point, where a concurrent accept/revoke could otherwise
 * both succeed. Returns null when the invitation was already claimed/revoked/expired by the
 * time this runs — the caller should treat that as a 409.
 */
export async function claimInvitation(
  tx: Tx,
  invitationId: string
): Promise<ProjectInvitation | null> {
  const [claimed] = await tx
    .update(projectInvitations)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(projectInvitations.id, invitationId),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, new Date())
      )
    )
    .returning()
  return claimed ?? null
}
