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
