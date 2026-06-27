import { getDb } from '@project-vault/db'
import { failedAuthAttempts } from '@project-vault/db/schema'
import { env } from '../../config/env.js'
import { normalizeEmail } from './normalize.js'

export type FailedAuthReason =
  | 'invalid_credentials'
  | 'invalid_totp'
  | 'invalid_recovery_code'
  | 'expired_recovery_code'

export async function recordFailedAuthAttempt(input: {
  userId?: string | null
  ipAddress: string
  attemptedEmail: string
  reason: FailedAuthReason
}): Promise<void> {
  if (!env.FAILED_AUTH_RECORD_ENABLED || process.env['FAILED_AUTH_RECORD_ENABLED'] === 'false') {
    return
  }

  try {
    await getDb()
      .insert(failedAuthAttempts)
      .values({
        userId: input.userId ?? null,
        ipAddress: input.ipAddress,
        attemptedEmail: normalizeEmail(input.attemptedEmail),
        reason: input.reason,
      })
  } catch (error) {
    process.stderr.write(
      `[auth.failed_auth_record_error] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}
