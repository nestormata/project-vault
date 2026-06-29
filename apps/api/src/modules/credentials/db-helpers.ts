import type { Tx } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'

export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (!cause || typeof cause !== 'object') return false
  return (cause as { code?: string }).code === '23505'
}

export async function currentKeyVersion(tx: Tx): Promise<number> {
  const [vs] = await tx.select({ keyVersion: vaultState.keyVersion }).from(vaultState).limit(1)
  return vs?.keyVersion ?? 1
}
