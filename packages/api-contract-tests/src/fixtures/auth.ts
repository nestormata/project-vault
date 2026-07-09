import { randomUUID } from 'node:crypto'
import * as OTPAuth from 'otpauth'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import type { TestApp } from './app-instance.js'
import { type CookieJar, cookieHeader, describeResponse, parseSetCookies } from './http.js'

export type RegisteredUser = {
  userId: string
  orgId: string
  email: string
  password: string
  cookies: CookieJar
}

const LOGIN_SECRET = 'contract-test-correct-horse-battery-staple'

/**
 * Re-authenticates an already-registered user and returns a *fresh* cookie jar, without creating
 * a new org. Used by the generic per-operation pass to mint a throwaway session for every
 * mutation-method call — some operations under test are themselves session-revoking (e.g.
 * `DELETE /api/v1/auth/sessions`), and reusing one shared cookie jar across the whole enumerated
 * operation list would let one such call permanently break every later test in the same run.
 */
export async function login(
  app: TestApp,
  user: Pick<RegisteredUser, 'email' | 'password'>
): Promise<CookieJar> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: user.email, password: user.password },
  })
  if (res.statusCode !== 200) {
    throw new Error(`Contract test fixture re-login failed: ${describeResponse(res)}`)
  }
  return parseSetCookies(res.headers['set-cookie'])
}

/**
 * D6 point 3(c): real `POST /api/v1/auth/register` + `POST /api/v1/auth/login` `app.inject()`
 * calls — not a hand-synthesized JWT — so the contract suite's own auth bootstrap exercises the
 * real auth path, same as every route it's about to test.
 */
export async function registerAndLogin(
  app: TestApp,
  emailPrefix: string,
  orgNamePrefix: string
): Promise<RegisteredUser> {
  const email = `${emailPrefix}-${randomUUID()}@example.com`
  const orgName = `${orgNamePrefix} ${randomUUID()}`

  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: LOGIN_SECRET, orgName },
  })
  if (register.statusCode !== 201) {
    throw new Error(`Contract test fixture registration failed: ${describeResponse(register)}`)
  }
  const registerBody = register.json<{ data: { userId: string; orgId: string } }>()

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: LOGIN_SECRET },
  })
  if (login.statusCode !== 200) {
    throw new Error(`Contract test fixture login failed: ${describeResponse(login)}`)
  }

  return {
    userId: registerBody.data.userId,
    orgId: registerBody.data.orgId,
    email,
    password: LOGIN_SECRET,
    cookies: parseSetCookies(login.headers['set-cookie']),
  }
}

/**
 * Enrolls TOTP MFA for an already-registered user via the real enroll/verify-enrollment routes
 * (same two-step flow a human user would follow), returning a fresh cookie jar (enrollment does
 * not require re-login in this codebase — the existing session cookie remains valid).
 */
export async function enrollMfa(app: TestApp, user: RegisteredUser): Promise<void> {
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/enroll',
    headers: { cookie: cookieHeader(user.cookies) },
    payload: {},
  })
  if (enroll.statusCode !== 200) {
    throw new Error(`Contract test MFA enrollment failed: ${describeResponse(enroll)}`)
  }
  const secret = enroll.json<{ data: { secret: string } }>().data.secret
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate()

  const verify = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/mfa/verify-enrollment',
    headers: { cookie: cookieHeader(user.cookies) },
    payload: { totp },
  })
  if (verify.statusCode !== 200) {
    throw new Error(`Contract test MFA enrollment verification failed: ${describeResponse(verify)}`)
  }
}

/**
 * D6 point 3(d)/sequencing note: feature-detects the platform-operator mechanism
 * (`users.is_platform_operator`, introduced by Story 9.1/9.2) and, when available, registers,
 * MFA-enrolls (required to hold platform-operator status in this codebase), and promotes a
 * fresh user to be the instance's sole platform operator. Returns `null` (a graceful, logged
 * skip — not a suite failure) when the mechanism doesn't exist yet, so this suite composes
 * correctly regardless of whether Stories 9.1/9.2 have landed.
 */
export async function tryBootstrapPlatformOperator(app: TestApp): Promise<RegisteredUser | null> {
  try {
    const operator = await registerAndLogin(app, 'contract-platform-op', 'Contract Platform Op')
    await enrollMfa(app, operator)

    await getDb().transaction(async (tx) => {
      await tx
        .update(users)
        .set({ isPlatformOperator: false })
        .where(eq(users.isPlatformOperator, true))
      await tx.update(users).set({ isPlatformOperator: true }).where(eq(users.id, operator.userId))
    })

    return operator
  } catch (error) {
    // eslint-disable-next-line no-console -- intentional suite-summary note, not app logging
    console.info(
      `[api-contract-tests] platform-operator bootstrap skipped (mechanism unavailable or errored): ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}
