import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentials, vaultState } from '@project-vault/db/schema'

export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (!cause || typeof cause !== 'object') return false
  return (cause as { code?: string }).code === '23505'
}

export async function currentKeyVersion(tx: Tx): Promise<number> {
  const [vs] = await tx.select({ keyVersion: vaultState.keyVersion }).from(vaultState).limit(1)
  return vs?.keyVersion ?? 1
}

async function findCredentialIdInProject(
  tx: Tx,
  params: { credentialId: string; projectId: string },
  opts: { forUpdate: boolean }
): Promise<{ id: string } | null> {
  const query = tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId))
    )
  const [row] = await (opts.forUpdate ? query.for('update') : query).limit(1)
  return row ?? null
}

/** Row-locks the credential (FOR UPDATE) scoped to its project, returning its id or null if it
 *  doesn't exist in that project. Shared by every mutation that must serialize concurrent
 *  writes to a credential's version history (add-version, rotation initiation, import). */
export function lockCredentialInProject(
  tx: Tx,
  params: { credentialId: string; projectId: string }
): Promise<{ id: string } | null> {
  return findCredentialIdInProject(tx, params, { forUpdate: true })
}

/** Plain (non-locking) existence check for a credential scoped to its project — used by
 *  read-only routes that only need to know whether the resource exists. */
export async function credentialExistsInProject(
  tx: Tx,
  params: { credentialId: string; projectId: string }
): Promise<boolean> {
  return Boolean(await findCredentialIdInProject(tx, params, { forUpdate: false }))
}
