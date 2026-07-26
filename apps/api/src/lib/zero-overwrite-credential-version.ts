import { and, eq, type SQL } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentialVersions } from '@project-vault/db/schema'

/** Zero-overwrite then null: defense-in-depth/intent-signaling, not byte-level erasure under
 *  PostgreSQL MVCC (see AC-8 MVCC caveat) — true shredding is key destruction at master-key
 *  rotation (Epic 5+). Shared by prune-credential-versions.ts's purgeVersion and
 *  rotation/service.ts's retireRotation, which both need this same first step before nulling
 *  encryptedValue/keyVersion out — split out purely to dedupe the two identical UPDATEs;
 *  callers still perform their own (differently-shaped) second update. */
export async function zeroOverwriteCredentialVersionValue(
  tx: Tx,
  versionId: string,
  extraWhere?: SQL
): Promise<void> {
  await tx
    .update(credentialVersions)
    .set({
      encryptedValue: {
        version: 1,
        iv: '0'.repeat(24),
        ciphertext: '0'.repeat(64),
        tag: '0'.repeat(32),
      },
    })
    .where(
      extraWhere
        ? and(eq(credentialVersions.id, versionId), extraWhere)
        : eq(credentialVersions.id, versionId)
    )
}
