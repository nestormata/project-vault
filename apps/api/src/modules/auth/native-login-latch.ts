import { eq, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { systemSettings } from '@project-vault/db/schema'

/**
 * Story 23.2 AC-4a/AC-11: storage for the native-login-replacement proving latch. Reuses the
 * existing `system_settings` instance-scoped singleton (Task 2's "check for an existing
 * instance-scoped store before adding a new table") rather than a dedicated table — this is the
 * one additive migration AC-11 permits.
 */

export type ReplacementLatch = {
  replacementProvenAt: string | null
  // Story 23.2 fix (code review): which extension's manifest `name` actually proved the
  // replacement — the same stable identity string already used for this purpose in every AC-9
  // audit payload (see fanoutAudit() call sites in native-login-policy.ts). NULL means either
  // "never proven" (replacementProvenAt is also NULL) or a pre-fix row written before this
  // column existed — the caller must not treat a NULL identity as "matches the currently loaded
  // extension"; see resolveCorePolicy()'s consumption of this value.
  provenByExtension: string | null
}

export async function readReplacementLatch(): Promise<ReplacementLatch | null> {
  const [row] = await getDb()
    .select({
      replacementProvenAt: systemSettings.nativeLoginReplacementProvenAt,
      provenByExtension: systemSettings.nativeLoginReplacementProvenByExtension,
    })
    .from(systemSettings)
    .where(eq(systemSettings.id, 1))
    .limit(1)
  if (!row) return null
  return {
    replacementProvenAt: row.replacementProvenAt?.toISOString() ?? null,
    provenByExtension: row.provenByExtension ?? null,
  }
}

/**
 * Idempotent, concurrency-safe: the first caller (across any number of racing workers) sets
 * `native_login_replacement_proven_at` (and, alongside it, which extension proved it); every
 * subsequent call is a no-op that preserves the earliest timestamp/extension pairing — including
 * a later call from a DIFFERENT extension, which must never overwrite an earlier extension's
 * proof (that would let a second, unrelated extension silently inherit the first's proof for
 * itself the next time IT is loaded). Ensures the singleton row exists first (id=1) since a
 * fresh instance may never have had `PUT /admin/settings` called.
 */
/**
 * Story 23.2 fix (code review): the single point of truth for "does this latch's proof actually
 * apply to the extension that is loaded right now." Only one extension package can be loaded at
 * a time, but operators can swap `VAULT_EXTENSIONS_PACKAGE` across restarts — without this check,
 * proof recorded for extension A would be silently inherited by an unrelated extension B on B's
 * very first boot, disabling native login before B's own mechanism has ever been shown to work.
 * A NULL `currentExtensionName` (nothing loaded, or load failed) or a NULL/mismatched
 * `provenByExtension` (never proven, or proven by a different/legacy-pre-fix extension) both
 * resolve to "not proven for this boot" — the fail-safe direction.
 */
export function isLatchProvenForExtension(
  latch: ReplacementLatch | null,
  currentExtensionName: string | null
): boolean {
  if (!latch?.replacementProvenAt) return false
  if (!currentExtensionName) return false
  return latch.provenByExtension === currentExtensionName
}

export async function writeReplacementLatch(extensionName: string): Promise<void> {
  const db = getDb()
  await db
    .insert(systemSettings)
    .values({ id: 1 })
    .onConflictDoNothing({ target: systemSettings.id })
  await db.execute(sql`
    UPDATE system_settings
    SET native_login_replacement_proven_at = now(),
        native_login_replacement_proven_by_extension = ${extensionName}
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
