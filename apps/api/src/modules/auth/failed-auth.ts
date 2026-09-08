import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { failedAuthAttempts } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import { normalizeEmail } from './normalize.js'

export type FailedAuthReason =
  'invalid_credentials' | 'invalid_totp' | 'invalid_recovery_code' | 'expired_recovery_code'

export async function recordFailedAuthAttempt(input: {
  userId?: string | null
  ipAddress: string
  attemptedEmail: string
  reason: FailedAuthReason
}): Promise<void> {
  // `env` is parsed once at import time, so vi.stubEnv() in tests can't change the
  // already-parsed env.FAILED_AUTH_RECORD_ENABLED — check process.env too so tests can
  // toggle this without re-importing the env module.
  if (!env.FAILED_AUTH_RECORD_ENABLED || process.env['FAILED_AUTH_RECORD_ENABLED'] === 'false') {
    return
  }

  try {
    await getDb()
      .insert(failedAuthAttempts)
      .values({
        userId: input.userId ?? null,
        ipAddress: input.ipAddress,
        attemptedEmail: normalizeAttemptedEmail(input.attemptedEmail),
        reason: input.reason,
      })
  } catch (error) {
    process.stderr.write(
      `[auth.failed_auth_record_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}

function normalizeAttemptedEmail(email: string): string {
  try {
    return normalizeEmail(email)
  } catch {
    return email.trim().toLowerCase().slice(0, 320)
  }
}

// Story 1.22 AC-1: sliding-window per-email login lockout check, sibling to
// recordFailedAuthAttempt(). Keyed on the same normalized email string
// recordFailedAuthAttempt() itself writes into attempted_email (both go through
// normalizeAttemptedEmail(), which wraps normalizeEmail() from normalize.ts — the identical
// normalization loginUser() applies before resolving the account via findLoginUser()), so the
// count observed here is guaranteed to match the exact string that would resolve the targeted
// account. Runs against the platform-scoped getDb() connection (AC-10: failed_auth_attempts has
// no org_id and is not RLS-scoped) using the existing idx_failed_auth_attempts_email_time index
// (filters on lower(attempted_email) + attempted_at, matching that index's column order) — no
// new migration/index needed. Deliberately unlocked/racy under concurrency (AC-11): a plain
// COUNT(*), no SELECT ... FOR UPDATE/advisory lock, matching check-failed-auth-threshold.ts's own
// counting approach — see Dev Notes "Concurrent access" for the trade-off rationale.
export async function isLoginLockedOut(email: string): Promise<boolean> {
  const normalizedEmail = normalizeAttemptedEmail(email)
  const windowStartIso = new Date(
    Date.now() - env.LOGIN_LOCKOUT_WINDOW_SECONDS * 1000
  ).toISOString()
  const rows = await getDb().execute<{ attempt_count: string | number }>(sql`
    SELECT COUNT(*)::text AS attempt_count
    FROM failed_auth_attempts
    WHERE lower(attempted_email) = ${normalizedEmail}
      AND attempted_at >= ${windowStartIso}::timestamptz
  `)
  const count = Number(rows[0]?.attempt_count ?? 0)
  return count >= env.LOGIN_LOCKOUT_THRESHOLD
}
