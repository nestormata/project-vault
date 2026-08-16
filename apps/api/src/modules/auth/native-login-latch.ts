import { eq, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { systemSettings } from '@project-vault/db/schema'

/**
 * Story 23.2 AC-4a/AC-11: storage for the native-login-replacement proving latch. Reuses the
 * existing `system_settings` instance-scoped singleton (Task 2's "check for an existing
 * instance-scoped store before adding a new table") rather than a dedicated table — this is the
 * one additive migration AC-11 permits.
 */

export type ReplacementLatch = { replacementProvenAt: string | null }

export async function readReplacementLatch(): Promise<ReplacementLatch | null> {
  const [row] = await getDb()
    .select({ replacementProvenAt: systemSettings.nativeLoginReplacementProvenAt })
    .from(systemSettings)
    .where(eq(systemSettings.id, 1))
    .limit(1)
  if (!row) return null
  return { replacementProvenAt: row.replacementProvenAt?.toISOString() ?? null }
}

/**
 * Idempotent, concurrency-safe: the first caller (across any number of racing workers) sets
 * `native_login_replacement_proven_at`; every subsequent call is a no-op that preserves the
 * earliest timestamp. Ensures the singleton row exists first (id=1) since a fresh instance may
 * never have had `PUT /admin/settings` called.
 */
export async function writeReplacementLatch(): Promise<void> {
  const db = getDb()
  await db
    .insert(systemSettings)
    .values({ id: 1 })
    .onConflictDoNothing({ target: systemSettings.id })
  await db.execute(sql`
    UPDATE system_settings
    SET native_login_replacement_proven_at = now()
    WHERE id = 1 AND native_login_replacement_proven_at IS NULL
  `)
}

/**
 * Story 23.2 AC-9: the once-per-instance NATIVE_LOGIN_DISABLED fanout guard. Returns true only
 * for the single process (across any number of racing workers) whose atomic conditional UPDATE
 * actually flips `disabled_announced_at` from NULL — only that process performs the per-org
 * audit fanout.
 */
export async function markDisabledAnnouncedIfFirst(): Promise<boolean> {
  const db = getDb()
  await db
    .insert(systemSettings)
    .values({ id: 1 })
    .onConflictDoNothing({ target: systemSettings.id })
  const result = await db.execute(sql`
    UPDATE system_settings
    SET native_login_disabled_announced_at = now()
    WHERE id = 1 AND native_login_disabled_announced_at IS NULL
    RETURNING id
  `)
  return result.length > 0
}
