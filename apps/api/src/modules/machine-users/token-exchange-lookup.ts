import { eq } from 'drizzle-orm'
import { apiKeys, machineUsers } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'
import { isMachineKeyLive } from './key-validity.js'

export type ApiKeyByHashRow = {
  id: string
  orgId: string
  machineUserId: string
  projectId: string
  keyHash: string
  expiresAt: Date | null
  revokedAt: Date | null
  overlapExpiresAt: Date | null
  rotatedFromKeyId: string | null
  lastUsedAt: Date | null
  machineUserRole: string
  machineUserDeactivatedAt: Date | null
}

/**
 * Story 7.2 D2 — resolves 7.1's D8 handoff. The caller's org is unknown until the API key is
 * resolved by its hash, so a per-org RLS-scoped scan isn't an option here (querying `api_keys`
 * under its standard RLS policy with no `app.current_org_id` set returns zero rows by
 * construction). This is a single point-lookup by the (non-unique-by-design, see api-keys.ts)
 * `key_hash` index via the admin connection — the 256-bit API key is itself the authorization
 * credential, the same trust model already documented for `findInvitationByTokenHash`
 * (`modules/invitations/lookup.ts`) and `findRecoveryTokenByHash` (`modules/auth/recovery-lookup.ts`).
 * Once the owning org is resolved, every subsequent read/write in this story runs inside a normal
 * `withOrg(orgId, ...)` transaction — this admin-connection lookup is a single, narrowly-scoped
 * exception, not a pattern that spreads further into the request lifecycle.
 */
export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyByHashRow | null> {
  const [row] = await getAdminDb()
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      machineUserId: apiKeys.machineUserId,
      projectId: machineUsers.projectId,
      keyHash: apiKeys.keyHash,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      overlapExpiresAt: apiKeys.overlapExpiresAt,
      rotatedFromKeyId: apiKeys.rotatedFromKeyId,
      lastUsedAt: apiKeys.lastUsedAt,
      machineUserRole: machineUsers.role,
      machineUserDeactivatedAt: machineUsers.deactivatedAt,
    })
    .from(apiKeys)
    .innerJoin(machineUsers, eq(machineUsers.id, apiKeys.machineUserId))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)
  return row ?? null
}

/**
 * AC-3: a key is usable for token exchange only if it is non-revoked, non-expired, and its
 * owning machine user is not deactivated. Mirrors the exact validity condition AC-23's
 * `hasActiveMachineUserKeys()` archival-guard query independently re-checks.
 */
export function isApiKeyValidForExchange(
  row: Pick<ApiKeyByHashRow, 'revokedAt' | 'expiresAt' | 'machineUserDeactivatedAt'>,
  now: Date = new Date()
): boolean {
  return isMachineKeyLive(row, now)
}

/**
 * AC-2 step 5 — updates `lastUsedAt` via the same admin connection as the lookup (the caller's
 * org context isn't established yet at this point in the request, so this is the one other
 * admin-connection write in this story, alongside the lookup itself).
 */
export async function touchApiKeyLastUsed(keyId: string, now: Date = new Date()): Promise<void> {
  await getAdminDb().update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, keyId))
}
