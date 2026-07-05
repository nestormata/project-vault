import { and, eq, gt, isNull, or } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { apiKeys, machineUsers } from '@project-vault/db/schema'

export type ActiveMachineUserKey = { machineUserId: string; keyId: string }

/**
 * Story 7.2 D12 — the single source of truth consumed by BOTH `hasActiveMachineUserKeys()` (the
 * archive-transaction guard, Story 4.4) and `GET .../machine-users/active-keys` (AC-23's
 * standalone read endpoint) — deliberately never duplicated into two queries that could
 * disagree about what counts as "active". A key counts as active exactly when it could still be
 * used to authenticate: non-revoked and (no expiry or not yet expired) — the same validity
 * condition `POST /api/v1/auth/machine-token` itself checks (AC-2/AC-3).
 */
export async function activeMachineUserKeysQuery(
  tx: Tx,
  projectId: string
): Promise<ActiveMachineUserKey[]> {
  const rows = await tx
    .select({ machineUserId: apiKeys.machineUserId, keyId: apiKeys.id })
    .from(apiKeys)
    .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
    .where(
      and(
        eq(machineUsers.projectId, projectId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))
      )
    )
  return rows
}
