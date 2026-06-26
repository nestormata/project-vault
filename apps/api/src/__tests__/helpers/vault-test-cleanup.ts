import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'

/**
 * Resets both DB and in-memory vault state between integration test cases.
 * The vault_state table is append-only in production (trigger-enforced); the
 * test-only `app.vault_test_reset` GUC (scoped to this transaction via SET LOCAL)
 * lets this helper bypass that guarantee without weakening it elsewhere.
 */
export async function resetVaultForTest(): Promise<void> {
  const { zeroKeys, loadInitialVaultState } = await import('../../modules/vault/key-service.js')
  zeroKeys() // clears keys; temporarily sets _status = 'sealed'
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.vault_test_reset', 'true', true)`)
    await tx.delete(vaultState)
  })
  await loadInitialVaultState() // RE-SYNC: no row → 'uninitialized'; row exists → 'sealed'
}
