import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { cookieHeader, registerAndLoginViaApi } from './auth-test-helpers.js'
import { totpForSecret } from './totp.js'
import type { createApp } from '../../app.js'

type TestApp = Awaited<ReturnType<typeof createApp>>

export async function enrollUserWithMfa(
  app: TestApp,
  options: {
    emailPrefix: string
    orgNamePrefix: string
    password: string
    closeApp?: boolean
  }
) {
  const email = `${options.emailPrefix}-${randomUUID()}@example.com`
  const registered = await registerAndLoginViaApi(app, {
    email,
    password: options.password,
    orgName: `${options.orgNamePrefix} ${randomUUID()}`,
  })
  const cookies = cookieHeader(registered.cookies)

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/enroll',
    headers: { cookie: cookies },
    payload: {},
  })
  expect(enroll.statusCode).toBe(200)
  const secret = enroll.json<{ data: { secret: string } }>().data.secret

  // Compute the enrollment TOTP once and reuse it below (rather than calling totpForSecret()
  // again later) — a second call at a new Date.now() can land in a different 30s TOTP period
  // under CI/CPU contention, silently producing a fresh, never-used code instead of the one
  // that actually confirmed enrollment. That mismatch made mfa-login.test.ts's replay-detection
  // test flaky: it "replayed" a code that was never really used, so login legitimately succeeded.
  const enrollmentTotp = totpForSecret(secret)
  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/verify-enrollment',
    headers: { cookie: cookies },
    payload: { totp: enrollmentTotp },
  })
  expect(verify.statusCode).toBe(200)

  if (options.closeApp) {
    await app.close()
  }

  return { ...registered, email, secret, enrollmentTotp, cookies: registered.cookies }
}
