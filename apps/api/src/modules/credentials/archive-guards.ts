import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { Tx } from '@project-vault/db'
import { credentials, credentialShares, rotations } from '@project-vault/db/schema'
import { BLOCKING_ROTATION_STATUSES } from '../projects/archive-guards.js'

// Story 28.5 AC4 — standard 410 body every write guard on an archived credential MUST return,
// mirroring PROJECT_ARCHIVED_ERROR's exact shape/precedent (archive-guards.ts, project module).
export const CREDENTIAL_ARCHIVED_ERROR = {
  code: 'credential_archived',
  message: 'This secret is archived and cannot be modified. Unarchive it first.',
} as const

/**
 * Story 28.5 AC2 — the rotation-blocking guard, scoped by credentialId directly (rotations
 * already carries credentialId — no join through projects needed, unlike the project-level
 * `findBlockingRotationIds`). Reuses `BLOCKING_ROTATION_STATUSES` verbatim (never a second,
 * independently-maintained list) per the story's Key Design Decisions.
 */
export async function findBlockingRotationIdsForCredential(
  tx: Tx,
  credentialId: string
): Promise<string[]> {
  const rows = await tx
    .select({ id: rotations.id })
    .from(rotations)
    .where(
      and(
        eq(rotations.credentialId, credentialId),
        inArray(rotations.status, BLOCKING_ROTATION_STATUSES)
      )
    )
  return rows.map((r) => r.id)
}

/**
 * Story 28.5 AC2 — the active-share-blocking guard, scoped by credentialId directly
 * (credential_shares already carries credentialId — no join through credentials needed, unlike
 * the project-level `findBlockingShareIds`).
 */
export async function findBlockingShareIdsForCredential(
  tx: Tx,
  credentialId: string
): Promise<string[]> {
  const rows = await tx
    .select({ id: credentialShares.id })
    .from(credentialShares)
    .where(
      and(eq(credentialShares.credentialId, credentialId), eq(credentialShares.status, 'active'))
    )
  return rows.map((r) => r.id)
}

/** Returns true if the credential itself is archived (caller should reject the mutation with 410). */
export async function isCredentialArchived(tx: Tx, credentialId: string): Promise<boolean> {
  const [row] = await tx
    .select({ archivedAt: credentials.archivedAt })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1)
  return row?.archivedAt != null
}

/**
 * Story 28.5 AC4 — shared one-line write-guard call for every mutation route on a credential:
 * sends the 410 response and returns true if the credential is archived, so callers can
 * `if (await rejectIfCredentialArchived(...)) return reply`. Mirrors `rejectIfProjectArchived`.
 */
export async function rejectIfCredentialArchived(
  tx: Tx,
  credentialId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (!(await isCredentialArchived(tx, credentialId))) return false
  reply.status(410).send(CREDENTIAL_ARCHIVED_ERROR)
  return true
}
