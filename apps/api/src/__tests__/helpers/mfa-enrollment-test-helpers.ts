import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect } from 'vitest'
import { getDb } from '@project-vault/db'
import type { createApp } from '../../app.js'
import { initVaultForTest, registerAndLoginViaApi } from './auth-test-helpers.js'
import { totpForSecret } from './totp.js'

const MFA_ENROLL_URL = '/api/v1/auth/mfa/enroll'
const MFA_VERIFY_ENROLLMENT_URL = '/api/v1/auth/mfa/verify-enrollment'
const MFA_REGENERATE_RECOVERY_CODES_URL = '/api/v1/auth/mfa/regenerate-recovery-codes'
const MFA_RECOVER_URL = '/api/v1/auth/mfa/recover'

type TestApp = Awaited<ReturnType<typeof createApp>>
type InitVault = Parameters<typeof initVaultForTest>[0]

/** Shared boot/teardown scaffold for MFA integration suites (vault reset + rate-limit bucket clear). */
export function registerMfaIntegrationLifecycle(opts: {
  initVault: InitVault
  passphrase: string
  resetVaultForTest: () => Promise<void>
}): void {
  beforeAll(async () => {
    await opts.resetVaultForTest()
    await initVaultForTest(opts.initVault, opts.passphrase)
  })

  beforeEach(async () => {
    await getDb().execute(sql`DELETE FROM auth_rate_limit_buckets`)
  })

  afterAll(async () => {
    await opts.resetVaultForTest()
  })
}

export async function registerAndLoginForMfaTests(
  createAppFn: typeof createApp,
  password: string,
  emailPrefix: string
) {
  const app = await createAppFn({ logger: false })
  const email = `${emailPrefix}-${randomUUID()}@example.com`
  const result = await registerAndLoginViaApi(app, {
    email,
    password,
    orgName: `${emailPrefix} ${randomUUID()}`,
  })
  await app.close()
  return { ...result, email }
}

export async function startMfaEnrollment(app: TestApp, cookies: string): Promise<string> {
  const enroll = await app.inject({
    method: 'POST',
    url: MFA_ENROLL_URL,
    headers: { cookie: cookies },
    payload: {},
  })
  expect(enroll.statusCode).toBe(200)
  const enrollBody = enroll.json<{ data: { secret: string; qrCodeSvg: string } }>()
  expect(enrollBody.data.qrCodeSvg).toContain('<svg')
  return enrollBody.data.secret
}

export async function enrollAndVerifyMfaWithSecret(
  app: TestApp,
  cookies: string
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const secret = await startMfaEnrollment(app, cookies)

  const verify = await app.inject({
    method: 'POST',
    url: MFA_VERIFY_ENROLLMENT_URL,
    headers: { cookie: cookies },
    payload: { totp: totpForSecret(secret) },
  })
  expect(verify.statusCode).toBe(200)
  return {
    secret,
    recoveryCodes: verify.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes,
  }
}

export async function enrollAndVerifyMfa(app: TestApp, cookies: string): Promise<string[]> {
  const result = await enrollAndVerifyMfaWithSecret(app, cookies)
  return result.recoveryCodes
}

export async function recoverWithCodeViaApi(
  app: TestApp,
  input: { email: string; password: string; recoveryCode: string }
) {
  return app.inject({ method: 'POST', url: MFA_RECOVER_URL, payload: input })
}

export async function regenerateRecoveryCodesViaApi(app: TestApp, cookies: string, totp: string) {
  return app.inject({
    method: 'POST',
    url: MFA_REGENERATE_RECOVERY_CODES_URL,
    headers: { cookie: cookies },
    payload: { totp },
  })
}
