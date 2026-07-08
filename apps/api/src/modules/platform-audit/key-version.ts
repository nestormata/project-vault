import type { Tx } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'

/** Story 9.4 D3/AC-5: reads only vault_state.platform_audit_key_version — never assumes it moves
 * together with audit_key_version or key_version, which each have their own independent
 * rotation lifecycle. */
export async function currentPlatformAuditKeyVersion(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ platformAuditKeyVersion: vaultState.platformAuditKeyVersion })
    .from(vaultState)
    .limit(1)
  return rows[0]?.platformAuditKeyVersion ?? 1
}
