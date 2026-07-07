import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { enrollUserWithMfa } from './mfa-enroll-test-helpers.js'
import type { createApp } from '../../app.js'

type TestApp = Awaited<ReturnType<typeof createApp>>

/**
 * Story 9.2: registers + logs in + MFA-enrolls a fresh user, then promotes them to the sole
 * platform operator on the instance. Mirrors Story 9.1's backup.routes.test.ts precedent — the
 * shared test database already has many registered users, so a fresh registration is very
 * unlikely to land the D1 "first user ever" bootstrap; this clears any existing
 * is_platform_operator row first (the unique partial index permits at most one instance-wide),
 * then promotes this user. isPlatformOperator is re-read from the DB per request (never cached
 * in the JWT), so no fresh login is needed after the promotion.
 */
export async function registerPlatformOperator(
  app: TestApp,
  options: { emailPrefix: string; orgNamePrefix: string; password: string }
) {
  const operator = await enrollUserWithMfa(app, options)
  await getDb().transaction(async (tx) => {
    await tx
      .update(users)
      .set({ isPlatformOperator: false })
      .where(eq(users.isPlatformOperator, true))
    await tx.update(users).set({ isPlatformOperator: true }).where(eq(users.id, operator.userId))
  })
  return operator
}
