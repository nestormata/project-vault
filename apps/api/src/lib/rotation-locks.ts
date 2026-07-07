import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'

/** Credential-scoped advisory lock (ADR-5.1-01) — shared by 5.1's normal-initiation, 5.3's
 *  break-glass initiation (AC-6), and 5.3's break-glass overlap-expiry job (AC-8, same key so a
 *  concurrent break-glass call on the same credential can never race the expiry job mid-transition). */
export async function tryAcquireCredentialScopedLock(
  tx: Tx,
  orgId: string,
  credentialId: string
): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('rotation:' || ${orgId} || ':' || ${credentialId}, 0)) AS locked`
  )
  return Boolean((rows[0] as { locked: boolean } | undefined)?.locked)
}

/** Blocks until the credential-scoped advisory lock's current holder's transaction ends
 *  (commit or rollback), then returns. Used by the losing side of a conflicting
 *  `tryAcquireCredentialScopedLock` call: querying for "who won" immediately after a failed
 *  non-blocking `pg_try_advisory_xact_lock` can race the winner's own transaction, which still
 *  has to lock the project row, lock the credential, and insert a new credential version before
 *  it ever inserts the `rotations` row that makes it visible — so a query that races ahead of
 *  that insert would spuriously see no in-progress rotation. Blocking on the same lock key
 *  guarantees the winner's transaction has already ended (and, if it committed, its `rotations`
 *  row is visible) before the caller looks it up. */
export async function awaitCredentialScopedLockRelease(
  tx: Tx,
  orgId: string,
  credentialId: string
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('rotation:' || ${orgId} || ':' || ${credentialId}, 0))`
  )
}

/** Rotation-scoped advisory lock (ADR-5.2-01) — shared by 5.2's confirm/fail/retry/complete,
 *  5.3's resume/abandon (AC-15), and 5.3's stale-detection job (AC-9, same key so the job can
 *  never race a concurrent human action on the same rotation). */
export async function tryAcquireRotationScopedLock(
  tx: Tx,
  orgId: string,
  rotationId: string
): Promise<boolean> {
  const rows = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('rotation:' || ${orgId} || ':' || ${rotationId}, 0)) AS locked`
  )
  return Boolean((rows[0] as { locked: boolean } | undefined)?.locked)
}
