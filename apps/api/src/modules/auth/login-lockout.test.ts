import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  failedAuthAttempts,
  notificationQueue,
  platformSecurityEvents,
  users,
} from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { isLoginLockedOut } from './failed-auth.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const TEST_PASSPHRASE = 'login-lockout-tests-passphrase'
const PASSWORD = 'correct-horse-battery-staple'
const LOGIN_URL = '/api/v1/auth/login'
const RECOVERY_REQUEST_URL = '/api/v1/auth/recovery/request'
const RECOVERY_LINK_CREATED_TEMPLATE = 'auth.recovery_link_created'

function uniqueEmail(label: string): string {
  return `login-lockout-${label}-${randomUUID()}@example.com`
}

/**
 * Seeds `count` raw failed_auth_attempts rows for `email`, mirroring what
 * rejectInvalidLogin()/recordFailedAuthAttempt() would have written for repeated wrong-password
 * attempts against that email. `userId: null` mirrors an attempt whose email did not resolve to
 * a real account.
 */
async function seedFailedAttempts(
  email: string,
  count: number,
  userId: string | null = null
): Promise<void> {
  if (count === 0) return
  await getDb()
    .insert(failedAuthAttempts)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        ipAddress: '203.0.113.7',
        attemptedEmail: email.toLowerCase(),
        reason: 'invalid_credentials' as const,
      }))
    )
}

async function countFailedAttempts(email: string): Promise<number> {
  const rows = await getDb()
    .select({ id: failedAuthAttempts.id })
    .from(failedAuthAttempts)
    .where(eq(failedAuthAttempts.attemptedEmail, email.toLowerCase()))
  return rows.length
}

function login(app: TestApp, email: string, password: string) {
  return app.inject({ method: 'POST', url: LOGIN_URL, payload: { email, password } })
}

async function latestLoginFailedAuditRow(orgId: string) {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({ payload: auditLogEntries.payload })
      .from(auditLogEntries)
      .where(and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.eventType, 'LOGIN_FAILED')))
      .orderBy(desc(auditLogEntries.createdAt))
      .limit(1)
    return row
  })
}

async function latestPlatformSecurityEventFor(emailDomain: string) {
  const [row] = await getDb()
    .select({ payload: platformSecurityEvents.payload })
    .from(platformSecurityEvents)
    .where(
      and(
        eq(platformSecurityEvents.eventType, 'LOGIN_FAILED'),
        eq(platformSecurityEvents.emailDomain, emailDomain)
      )
    )
    .orderBy(desc(platformSecurityEvents.createdAt))
    .limit(1)
  return row
}

async function opaqueTokenFromQueue(orgId: string, recipientEmail: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ payload: notificationQueue.payload })
      .from(notificationQueue)
      .where(
        and(
          eq(notificationQueue.recipientEmail, recipientEmail),
          eq(notificationQueue.templateId, RECOVERY_LINK_CREATED_TEMPLATE)
        )
      )
      .orderBy(desc(notificationQueue.createdAt))
      .limit(1)
  )
  const payload = row?.payload as { recoveryUrl?: string } | undefined
  const url = payload?.recoveryUrl
  if (!url) throw new Error(`no recovery email queued for ${recipientEmail}`)
  const match = /\/recovery\/([^/?]+)/.exec(url)
  if (!match?.[1]) throw new Error(`could not extract token from ${url}`)
  return match[1]
}

describe('Story 1.22: no per-account login lockout', () => {
  let app: TestApp

  beforeAll(async () => {
    await resetVaultForTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
    app = await createApp({ logger: false })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  beforeEach(async () => {
    await getDb().delete(failedAuthAttempts)
  })

  // AC-1 happy path: 0-9 failed attempts in the window does not lock the account out.
  it('allows login with the correct password when fewer than the threshold of failed attempts were recorded', async () => {
    const email = uniqueEmail('happy')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout Happy Org ${randomUUID()}`,
    })
    await seedFailedAttempts(email, 9, owner.userId)

    const res = await login(app, email, PASSWORD)

    expect(res.statusCode).toBe(200)
  })

  // AC-1 boundary: exactly threshold-1 (9) attempts must NOT lock; exactly threshold (10) must.
  it('boundary: threshold-1 (9) recorded attempts does not lock out, threshold (10) does', async () => {
    const belowEmail = uniqueEmail('boundary-below')
    const below = await registerAndLoginViaApi(app, {
      email: belowEmail,
      password: PASSWORD,
      orgName: `Lockout Boundary Below Org ${randomUUID()}`,
    })
    await seedFailedAttempts(belowEmail, 9, below.userId)
    const belowRes = await login(app, belowEmail, PASSWORD)
    expect(belowRes.statusCode).toBe(200)

    const atEmail = uniqueEmail('boundary-at')
    const at = await registerAndLoginViaApi(app, {
      email: atEmail,
      password: PASSWORD,
      orgName: `Lockout Boundary At Org ${randomUUID()}`,
    })
    await seedFailedAttempts(atEmail, 10, at.userId)
    const atRes = await login(app, atEmail, PASSWORD)
    expect(atRes.statusCode).toBe(401)
  })

  // AC-1 edge case + AC-3: a real, correctly-passworded account with 10+ recent failed attempts
  // still gets 401, never 200 — the lockout overrides even a genuinely correct password, and
  // verifyLoginPassword() must still have run (proven by the account not short-circuiting into a
  // different, distinguishable error before password verification would occur).
  it('rejects a correct password with 401 when the account is locked out', async () => {
    const email = uniqueEmail('locked-real')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout Real Org ${randomUUID()}`,
    })
    await seedFailedAttempts(email, 10, owner.userId)

    const res = await login(app, email, PASSWORD)

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'invalid_credentials' })
  })

  // AC-1 edge case: a nonexistent email with 10+ recorded (userId: null) failed attempts locks
  // out identically to a real account (Decision 1 — no distinguishable "locked" state).
  it('rejects login for a nonexistent email with 401 once it has 10+ recorded failed attempts', async () => {
    const email = uniqueEmail('locked-nonexistent')
    await seedFailedAttempts(email, 10, null)

    const res = await login(app, email, 'whatever-password-1')

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'invalid_credentials' })
  })

  // AC-2: the locked-out response for a real account and for a nonexistent email must be
  // byte-for-byte identical (status + body) — regression guard mirroring Story 1.20's own AC-2.
  it('returns an identical locked-out response for a real account vs. a nonexistent email (anti-enumeration regression guard)', async () => {
    const realEmail = uniqueEmail('parity-real')
    const owner = await registerAndLoginViaApi(app, {
      email: realEmail,
      password: PASSWORD,
      orgName: `Lockout Parity Org ${randomUUID()}`,
    })
    await seedFailedAttempts(realEmail, 10, owner.userId)
    const realRes = await login(app, realEmail, PASSWORD)

    const nonexistentEmail = uniqueEmail('parity-nonexistent')
    await seedFailedAttempts(nonexistentEmail, 10, null)
    const nonexistentRes = await login(app, nonexistentEmail, PASSWORD)

    expect(realRes.statusCode).toBe(nonexistentRes.statusCode)
    expect(realRes.json()).toEqual(nonexistentRes.json())
  })

  // AC-4: recording is unchanged — a locked-out rejection still writes exactly one more
  // failed_auth_attempts row (the sliding window keeps extending with continued attempts).
  it('still records a failed_auth_attempts row for a locked-out rejection', async () => {
    const email = uniqueEmail('still-records')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout Records Org ${randomUUID()}`,
    })
    await seedFailedAttempts(email, 10, owner.userId)
    expect(await countFailedAttempts(email)).toBe(10)

    await login(app, email, PASSWORD)

    expect(await countFailedAttempts(email)).toBe(11)
  })

  // AC-9 happy path: a locked-out rejection for a real, resolvable account writes a LOGIN_FAILED
  // audit row with payload.reason === 'account_lockout', distinguishing it from a fresh wrong
  // password — internal-only, never surfaced in the HTTP response (still 401 invalid_credentials
  // above).
  it('writes an org-scoped LOGIN_FAILED audit row with reason account_lockout for a locked-out real account', async () => {
    const email = uniqueEmail('audit-real')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout Audit Org ${randomUUID()}`,
    })
    await seedFailedAttempts(email, 10, owner.userId)

    await login(app, email, PASSWORD)

    const row = await latestLoginFailedAuditRow(owner.orgId)
    expect(row?.payload).toMatchObject({ reason: 'account_lockout' })
  })

  // AC-9 edge case: a locked-out rejection for a nonexistent email writes the existing
  // platform-security-event (unresolvable-subject) path, tagged with the same distinguishing
  // reason rather than a new/different code path.
  it('writes a platform security event with reason account_lockout for a locked-out nonexistent email', async () => {
    const email = uniqueEmail('audit-nonexistent')
    await seedFailedAttempts(email, 10, null)

    await login(app, email, 'whatever-password-2')

    const domain = email.split('@')[1] as string
    const row = await latestPlatformSecurityEventFor(domain)
    expect(row?.payload).toMatchObject({ reason: 'account_lockout' })
  })

  // AC-12 happy path: an MFA-enrolled account below the lockout threshold with a correct
  // password still receives the existing pending-MFA challenge, unchanged.
  it('still returns the MFA challenge for an MFA-enrolled account below the lockout threshold', async () => {
    const email = uniqueEmail('mfa-below')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout MFA Below Org ${randomUUID()}`,
    })
    await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, owner.userId))
    await seedFailedAttempts(email, 9, owner.userId)

    const res = await login(app, email, PASSWORD)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { mfaRequired: true } })
  })

  // AC-12 edge case: an MFA-enrolled account ABOVE the lockout threshold never reaches the MFA
  // branch at all — it is rejected at the password stage exactly like a non-MFA account.
  it('rejects an MFA-enrolled account with the generic 401 (not the MFA challenge) once locked out', async () => {
    const email = uniqueEmail('mfa-above')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout MFA Above Org ${randomUUID()}`,
    })
    await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, owner.userId))
    await seedFailedAttempts(email, 10, owner.userId)

    const res = await login(app, email, PASSWORD)

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'invalid_credentials' })
    expect(res.json()).not.toHaveProperty('data')
  })

  // AC-7: /recovery/request and the completion flow are never gated by isLoginLockedOut() — a
  // locked-out user can always self-serve a password reset.
  it('completes the existing recovery request flow for an email with 10+ recorded failed login attempts', async () => {
    const email = uniqueEmail('recovery-independence')
    const owner = await registerAndLoginViaApi(app, {
      email,
      password: PASSWORD,
      orgName: `Lockout Recovery Org ${randomUUID()}`,
    })
    await seedFailedAttempts(email, 15, owner.userId)

    // The account is genuinely locked out of /login at this point.
    const lockedLogin = await login(app, email, PASSWORD)
    expect(lockedLogin.statusCode).toBe(401)

    // ...yet /recovery/request is completely unaffected.
    const recoveryRequest = await app.inject({
      method: 'POST',
      url: RECOVERY_REQUEST_URL,
      payload: { email },
    })
    expect(recoveryRequest.statusCode).toBe(202)

    const token = await opaqueTokenFromQueue(owner.orgId, email)

    const peek = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/recovery/${encodeURIComponent(token)}`,
    })
    expect(peek.statusCode).toBe(200)

    const newPassword = 'a-brand-new-recovery-password-1'
    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/recovery/${encodeURIComponent(token)}/complete`,
      payload: { newPassword },
    })
    expect(complete.statusCode).toBe(200)

    // The reset genuinely took effect, still despite the ongoing lockout window: a fresh login
    // with the new password is judged against the SAME email, so it is still subject to the
    // lockout (Decision 2 — recovery bypasses the block on /recovery itself, it does not clear
    // the counter), but /recovery's own success is what this AC is responsible for guaranteeing.
    expect(await isLoginLockedOut(email)).toBe(true)
  })

  // AC-7 (code inspection): neither recovery.ts nor the recovery route handlers in routes.ts
  // reference isLoginLockedOut at all — the lockout check is scoped entirely to loginUser().
  it('code inspection: the recovery module and recovery routes never call isLoginLockedOut', () => {
    const recoveryTsPath = fileURLToPath(new URL('./recovery.ts', import.meta.url))
    const routesTsPath = fileURLToPath(new URL('./routes.ts', import.meta.url))
    const recoverySource = readFileSync(recoveryTsPath, 'utf8')
    const routesSource = readFileSync(routesTsPath, 'utf8')

    expect(recoverySource).not.toContain('isLoginLockedOut')
    expect(routesSource).not.toContain('isLoginLockedOut')
  })

  // AC-6 (code inspection): the /login route registration itself carries no per-route
  // config.rateLimit override — it still relies solely on the module-level per-IP limiter. This
  // story is additive (a second, orthogonal per-email control), never a replacement.
  it('code inspection: the /login route registration has no per-route rate-limit override', () => {
    const routesTsPath = fileURLToPath(new URL('./routes.ts', import.meta.url))
    const routesSource = readFileSync(routesTsPath, 'utf8')
    const loginRouteStart = routesSource.indexOf("url: '/login',")
    expect(loginRouteStart).toBeGreaterThan(-1)
    const loginRouteChunk = routesSource.slice(loginRouteStart, loginRouteStart + 800)
    expect(loginRouteChunk).not.toContain('config: {')
    expect(loginRouteChunk).not.toContain('rateLimit')
  })

  // AC-1 normalization-consistency edge case (Red Team finding): isLoginLockedOut()'s
  // normalization must be the exact same normalizeEmail()-based algorithm findLoginUser()'s
  // resolution relies on — proven both by direct source reference and behaviorally (a
  // differently-cased variant of an already-counted email is still recognized as the same key).
  describe('normalization consistency (AC-1)', () => {
    it('code reference: failed-auth.ts and normalize.ts both centralize on normalizeEmail()', () => {
      const failedAuthTsPath = fileURLToPath(new URL('./failed-auth.ts', import.meta.url))
      const serviceTsPath = fileURLToPath(new URL('./service.ts', import.meta.url))
      const failedAuthSource = readFileSync(failedAuthTsPath, 'utf8')
      const serviceSource = readFileSync(serviceTsPath, 'utf8')

      // failed-auth.ts (isLoginLockedOut + recordFailedAuthAttempt's own normalization) imports
      // normalizeEmail from normalize.ts...
      expect(failedAuthSource).toContain("from './normalize.js'")
      expect(failedAuthSource).toContain('normalizeEmail(')
      // ...and service.ts's loginUser() resolves the account (findLoginUser) using the SAME
      // normalizeEmail()-normalized `email` value produced by normalizeLoginEmail(), rather than
      // a second, independent normalization.
      expect(serviceSource).toContain('normalizeEmail(rawEmail)')
      expect(serviceSource).toContain('const email = normalizeLoginEmail(input.email, meta)')
      expect(serviceSource).toContain('await isLoginLockedOut(email)')
      expect(serviceSource).toContain('await findLoginUser(email)')
    })

    it('behavioral: a mixed-case variant of an already-counted email is recognized as the same lockout key', async () => {
      const email = uniqueEmail('normalization')
      await seedFailedAttempts(email, 10, null)

      const mixedCaseVariant = email.toUpperCase()

      expect(await isLoginLockedOut(mixedCaseVariant)).toBe(true)
    })
  })
})
