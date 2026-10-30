import { eq } from 'drizzle-orm'
import { expect } from 'vitest'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { cookieHeader, type CookieJar } from './auth-test-helpers.js'
import { startMfaEnrollment } from './mfa-enrollment-test-helpers.js'
import { totpForSecret } from './totp.js'
import type { createApp } from '../../app.js'

type TestApp = Awaited<ReturnType<typeof createApp>>

const TOTP_PERIOD_MS = 30_000

export type EnrolledTotp = {
  secret: string
  /** The code that confirmed the enrollment, so it is already recorded as used. */
  enrollmentCode: string
  /** A code from the next period: valid now and never used, one per enrolled user. */
  freshCode: string
}

/**
 * Enrolls and confirms a TOTP authenticator for the user through the real routes. The membership
 * helpers only stamp `users.mfa_enrolled_at`; that stamp is cleared first so the enroll route
 * accepts the user (it answers 409 once a user counts as enrolled).
 */
export async function enrollTotpForSession(
  app: TestApp,
  userId: string,
  cookies: CookieJar
): Promise<EnrolledTotp> {
  await getDb().update(users).set({ mfaEnrolledAt: null }).where(eq(users.id, userId))
  const header = cookieHeader(cookies)
  const secret = await startMfaEnrollment(app, header)
  const enrollmentCode = totpForSecret(secret)
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/verify-enrollment',
    headers: { cookie: header },
    payload: { totp: enrollmentCode },
  })
  expect(verify.statusCode).toBe(200)
  return {
    secret,
    enrollmentCode,
    freshCode: totpForSecret(secret, Date.now() + TOTP_PERIOD_MS),
  }
}

/** A well-formed code far outside the accepted window, so it can never be the current one. */
export function wrongCodeFor(secret: string): string {
  return totpForSecret(secret, Date.now() + 20 * TOTP_PERIOD_MS)
}
