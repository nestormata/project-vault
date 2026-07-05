export type MachineKeyValidityFields = {
  revokedAt: Date | null
  expiresAt: Date | null
  machineUserDeactivatedAt: Date | null
}

/**
 * A machine-user API key is usable exactly when non-revoked, non-expired, and its owning
 * machine user is non-deactivated. Shared by machine-auth.ts's live-JWT recheck and
 * token-exchange-lookup.ts's pre-auth exchange check — both independently re-derived this exact
 * condition (jscpd flagged the duplication); archival-check.ts's activeMachineUserKeysQuery()
 * mirrors it in SQL for the same reason.
 */
export function isMachineKeyLive(row: MachineKeyValidityFields, now: Date = new Date()): boolean {
  if (row.revokedAt !== null) return false
  if (row.machineUserDeactivatedAt !== null) return false
  if (row.expiresAt !== null && row.expiresAt <= now) return false
  return true
}
