import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { projectInvitations } from '@project-vault/db/schema'

/**
 * D7 / AC-8: written before Epic 5 (Credential Rotation) shipped the `rotations` table. This stub
 * preserves the exact call site and return shape the real check needs (mirrors Story 4.4's
 * identical Epic 7 stub for its own forward dependency). Epic 5 has since shipped, but the query
 * is still not wired: do not mark FR102's rotation-block guarantee "done" in any tracking document
 * until story 43-15 replaces this function body.
 *
 * ADR-4.4-04 (reconciled, Epic 4 retro closure): the caller (routes.ts) surfaces `rotationIds`
 * on a 409 in the exact `{ error: 'active_rotations', rotationIds }` shape Story 4.4's archive
 * guard uses — both stub call sites are now byte-compatible.
 */
// Stub: never blocks. Blocking deactivation while the user has an in_progress/stale_recovery rotation is tracked as story 43-15-epic-43-completion-block-user-deactivation-during-active-rotation.
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
