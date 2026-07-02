import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { projectInvitations } from '@project-vault/db/schema'

/**
 * D7 / AC-8: Epic 5 (Credential Rotation) has not shipped — there is no `rotations` table yet, so
 * a real active-rotation block is impossible to implement today. This stub preserves the exact
 * call site and return shape the real check will need once Epic 5 lands (mirrors Story 4.4's
 * identical Epic 7 stub for its own forward dependency). Do not mark FR102's rotation-block
 * guarantee "done" in any tracking document until Epic 5 replaces this function body.
 */
// TODO: Epic 5 — query the `rotations` table for rows with status = 'in_progress' assigned to
// this user once Epic 5 ships. Until then, never block.
export async function checkActiveRotationsForUser(
  _userId: string,
  _orgId: string,
  _tx: Tx
): Promise<{ blocked: boolean; rotationIds: string[] }> {
  return { blocked: false, rotationIds: [] }
}

/**
 * AC-7: revokes every pending project invitation the deactivated user *sent* (invitedBy) within
 * this org — invitations addressed *to* them are untouched (D3/AC-7 edge case). Already-accepted,
 * already-revoked, or already-expired invitations are left alone (nothing to do).
 */
export async function revokePendingInvitationsSentBy(
  tx: Tx,
  input: { orgId: string; userId: string }
): Promise<number> {
  const revoked = await tx
    .update(projectInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(projectInvitations.orgId, input.orgId),
        eq(projectInvitations.invitedBy, input.userId),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, new Date())
      )
    )
    .returning({ id: projectInvitations.id })
  return revoked.length
}
