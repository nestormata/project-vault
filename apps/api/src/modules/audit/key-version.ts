import type { Tx } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'

export async function currentAuditKeyVersion(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ auditKeyVersion: vaultState.auditKeyVersion })
    .from(vaultState)
    .limit(1)
  return rows[0]?.auditKeyVersion ?? 1
}
