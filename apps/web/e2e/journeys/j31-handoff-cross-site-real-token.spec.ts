import postgres from 'postgres'
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import {
  countLoginSucceededAudit,
  countSessions,
  dbNow,
  expireNonceRowsSince,
  handoffStubPort,
  isJtiBurned,
  mintHandoffToken,
  nonceRowsSince,
  securityEventsSince,
  seedLinkedHandoffUser,
  startFakeIssuer,
  type FakeIssuer,
  type IssuerHit,
  type SeededHandoffUser,
} from '../fixtures/handoff.js'

// J31 (Story 60.6, rewritten for Story 73.1): the REAL nonce-bound handoff against the live e2e
// stack. `GET /auth/start` on PV web sets the host-only `__Host-pv-handoff-nonce` cookie and sends
// the browser to a fake issuer on http://127.0.0.1:<stub port> (a different SITE from PV's
// http://localhost:<port>). The issuer signs a token carrying that nonce with the stack's test-only
// key (fixtures/handoff-test-key.ts) and redirects to `/auth/claim#<token>`; the page posts the
// token and lands on /dashboard with no click. The login-CSRF cases prove a token is useless in a
// browser that does not hold its nonce.
//
// Rules for this file (E5): no page.route/context.route on /api/v1/auth/handoff/** (the real round
// trip is the point); every DB assertion is keyed by the seeded user/org or the minted jti, and
// nonce rows (stored as an HMAC under the stack's per-run secret) by creation time; a rendered page
// is never evidence on its own. Chromium only.
//
// Traces/videos kept on failure contain tokens and nonces. That is acceptable: test-only key, 30 s
// token, 120 s nonce, audience pv:pv-e2e only (E3d).

const NONCE_COOKIE = '__Host-pv-handoff-nonce'
const ERROR_HEADING = "Sign-in couldn't be completed"
const GENERIC_REJECTION = 'Sign-in could not be verified. Please start again.'

let sql: postgres.Sql
let issuer: FakeIssuer
let pvOrigin: string

function pvOriginFrom(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL
  if (!baseURL) throw new Error('j31: playwright.config.ts must set use.baseURL')
  return new URL(baseURL).origin
}

test.beforeAll(async () => {
  pvOrigin = pvOriginFrom(test.info())
  sql = postgres(superuserDatabaseUrl(), { max: 1 })
  issuer = await startFakeIssuer({ port: handoffStubPort(), pvOrigin })
})

test.afterAll(async () => {
  await issuer?.close()
  await sql?.end({ timeout: 5 })
})

function lastHit(): IssuerHit {
  const hit = issuer.hits.at(-1)
  if (!hit)
    throw new Error('j31: the fake issuer was never reached; is VAULT_HANDOFF_START_URL set?')
  return hit
}

function lastToken(): string {
  const minted = lastHit().minted
  if (!minted) throw new Error('j31: the last issuer hit signed no token')
  return minted.token
}

async function nonceCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies(pvOrigin)).find((cookie) => cookie.name === NONCE_COOKIE)?.value
}

async function expectSignedOut(page: Page): Promise<void> {
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
}

async function expectErrorState(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: ERROR_HEADING })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText(GENERIC_REJECTION)
  await expect(page.getByRole('button')).toHaveCount(0)
  // The e2e web pins VAULT_HANDOFF_ISSUER empty, so the return guidance is plain text.
  await expect(page.getByText(/start signing in again/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to CentralizeMe' })).toHaveCount(0)
}

async function expectRejectedWith(since: Date, eventTypes: string[]): Promise<void> {
  await expect
    .poll(async () => (await securityEventsSince(sql, since)).map((event) => event.eventType))
    .toEqual(eventTypes)
}

/** The attacker runs /auth/start in their own browser and captures their own token. */
async function attackerToken(
  context: BrowserContext,
  attacker: SeededHandoffUser
): Promise<IssuerHit> {
  issuer.plan({ subject: attacker, mode: 'return' })
  const page = await context.newPage()
  await page.goto(`${pvOrigin}/auth/start`)
  await expect(page.locator('body')).toHaveText(lastToken())
  await page.close()
  return lastHit()
}

/** The victim's browser holds a fresh nonce cookie of its own and no token. */
async function victimHoldingNonce(page: Page, victim: SeededHandoffUser): Promise<string> {
  issuer.plan({ subject: victim, mode: 'hold' })
  await page.goto(`${pvOrigin}/auth/start`)
  await expect(page.locator('body')).toHaveText('held')
  const cookie = await nonceCookie(page.context())
  expect(cookie, 'the victim holds a nonce cookie').toBe(lastHit().nonce)
  return lastHit().nonce
}

/** A victim browser opens `/auth/claim#<token>`: it must end in the error state, signed out, with
 *  exactly `eventType` recorded and no session for any of `users`. */
async function expectVictimRejected(
  page: Page,
  token: string,
  eventType: string,
  ...users: SeededHandoffUser[]
): Promise<void> {
  const since = await dbNow(sql)
  await page.goto(`${pvOrigin}/auth/claim#${token}`)
  await expectErrorState(page)
  await expectRejectedWith(since, [eventType])
  await expectSignedOut(page)
  for (const user of users) expect(await countSessions(sql, user.userId)).toBe(0)
}

/** `/auth/start` through the real redirect chain; resolves on the /auth/claim document. */
async function startHandoff(
  page: Page
): Promise<{ claimHtml: string; referrerPolicy: string | null }> {
  const claimDocument = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/auth/claim' &&
      response.request().resourceType() === 'document'
  )
  await page.goto(`${pvOrigin}/auth/start`)
  const response = await claimDocument
  return {
    claimHtml: await response.text(),
    referrerPolicy: await response.headerValue('referrer-policy'),
  }
}

test.describe('J31 — nonce-bound handoff: golden path, reuse and replay', () => {
  test.describe.configure({ mode: 'serial' })

  let user: SeededHandoffUser
  let goldenNonce: string
  let goldenToken: string

  test('AC1/AC2/AC5: /auth/start -> issuer -> /auth/claim#token lands on /dashboard with no click', async ({
    page,
    context,
  }) => {
    user = await seedLinkedHandoffUser(sql, 'golden')
    issuer.plan({ subject: user, mode: 'redirect' })
    expect(await context.cookies(pvOrigin)).toEqual([])
    const requests: Request[] = []
    page.on('request', (request) => requests.push(request))
    const since = await dbNow(sql)

    const { claimHtml, referrerPolicy } = await startHandoff(page)
    await page.waitForURL('**/dashboard')

    const hit = lastHit()
    goldenNonce = hit.nonce
    goldenToken = lastToken()
    expect(goldenNonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // AC5: the token reached PV only in the fragment and the page's own POST body.
    for (const request of requests) expect(request.url()).not.toContain(goldenToken)
    expect(referrerPolicy).toBe('no-referrer')
    expect(claimHtml).not.toContain('Confirm sign-in')
    expect(page.url()).not.toContain(goldenToken)
    // AC2: signed in for real, as the seeded user.
    const me = await page.request.get('/api/v1/auth/me')
    expect(me.status()).toBe(200)
    expect(((await me.json()) as { data: { userId: string } }).data.userId).toBe(user.userId)
    expect(await countSessions(sql, user.userId)).toBe(1)
    expect(await isJtiBurned(sql, hit.minted?.jti ?? '')).toBe(true)
    expect(await countLoginSucceededAudit(sql, user)).toBe(1)
    const nonces = await nonceRowsSince(sql, since)
    expect(nonces).toHaveLength(1)
    expect(nonces[0]?.consumedAt).not.toBeNull()
    expect(await nonceCookie(context)).toBeUndefined()
    expect(await securityEventsSince(sql, since)).toEqual([])
  })

  test('AC2 edge: the spent nonce with a FRESH valid token is handoff_nonce_reused, no new session', async ({
    page,
    context,
  }) => {
    // CDP refuses a Secure cookie for an http:// URL, so the spent nonce is planted from a PV page
    // the way a script on PV's own origin could (localhost is a secure context).
    await page.goto(`${pvOrigin}/auth/claim`)
    await page.evaluate(
      ([name, value]) => {
        document.cookie = `${name}=${value}; Secure; Path=/; SameSite=Lax`
      },
      [NONCE_COOKIE, goldenNonce]
    )
    expect(await nonceCookie(context)).toBe(goldenNonce)
    // Leave the page so the claim below is a full document load, not a same-document hash change.
    await page.goto('about:blank')
    const fresh = mintHandoffToken(user, { nonce: goldenNonce })
    const since = await dbNow(sql)

    await page.goto(`${pvOrigin}/auth/claim#${fresh.token}`)

    await expectErrorState(page)
    await expectRejectedWith(since, ['handoff_nonce_reused'])
    await expectSignedOut(page)
    expect(await countSessions(sql, user.userId)).toBe(1)
    expect(await nonceCookie(context)).toBeUndefined()
  })

  test('AC4: replaying the golden token in a browser with its own fresh nonce is a mismatch, no new session', async ({
    page,
  }) => {
    await victimHoldingNonce(page, user)
    const since = await dbNow(sql)

    await page.goto(`${pvOrigin}/auth/claim#${goldenToken}`)

    await expectErrorState(page)
    await expectRejectedWith(since, ['handoff_nonce_mismatch'])
    await expectSignedOut(page)
    expect(await countSessions(sql, user.userId)).toBe(1)
  })
})

test.describe('J31 — login CSRF: an attacker token in a victim browser (AC4)', () => {
  test("the attacker's token on a victim with no nonce cookie is handoff_nonce_missing", async ({
    browser,
    page,
  }) => {
    const attacker = await seedLinkedHandoffUser(sql, 'csrf-attacker')
    const attackerContext = await browser.newContext()
    try {
      const { minted } = await attackerToken(attackerContext, attacker)

      await expectVictimRejected(page, minted?.token ?? '', 'handoff_nonce_missing', attacker)
      expect(await isJtiBurned(sql, minted?.jti ?? '')).toBe(false)
    } finally {
      await attackerContext.close()
    }
  })

  test("the attacker's token on a victim holding its own nonce is handoff_nonce_mismatch", async ({
    browser,
    page,
  }) => {
    const attacker = await seedLinkedHandoffUser(sql, 'csrf-attacker-2')
    const victim = await seedLinkedHandoffUser(sql, 'csrf-victim')
    const attackerContext = await browser.newContext()
    try {
      const { minted } = await attackerToken(attackerContext, attacker)
      await victimHoldingNonce(page, victim)

      await expectVictimRejected(
        page,
        minted?.token ?? '',
        'handoff_nonce_mismatch',
        attacker,
        victim
      )
    } finally {
      await attackerContext.close()
    }
  })

  test('cookie tossing: a prefix-less nonce cookie is ignored (handoff_nonce_missing)', async ({
    browser,
    page,
    context,
  }) => {
    const attacker = await seedLinkedHandoffUser(sql, 'csrf-toss')
    const attackerContext = await browser.newContext()
    try {
      const { nonce, minted } = await attackerToken(attackerContext, attacker)
      await context.addCookies([{ name: 'pv-handoff-nonce', value: nonce, url: pvOrigin }])

      await expectVictimRejected(page, minted?.token ?? '', 'handoff_nonce_missing', attacker)
    } finally {
      await attackerContext.close()
    }
  })

  test('a cross-site POST to the claim route is refused before the api, and so is a direct cross-site request', async ({
    page,
    request,
  }) => {
    const victim = await seedLinkedHandoffUser(sql, 'csrf-cross-site')
    const nonce = await victimHoldingNonce(page, victim)
    const token = mintHandoffToken(victim, { nonce }).token
    const since = await dbNow(sql)

    await page.goto(`${issuer.origin}/cross-site#${token}`)
    const status = page.locator('#status')
    await expect(status).toHaveAttribute('data-status', /.+/)
    expect(['fetch-error', '403']).toContain(await status.getAttribute('data-status'))

    const direct = await request.post(`${pvOrigin}/api/v1/auth/handoff/claim`, {
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      data: { token },
    })
    expect(direct.status()).toBe(403)

    expect(await securityEventsSince(sql, since)).toEqual([])
    expect(await countSessions(sql, victim.userId)).toBe(0)
    await expectSignedOut(page)
  })
})

test.describe('J31 — nonce expiry, org and MFA (AC3, AC6)', () => {
  test('an expired nonce is handoff_nonce_expired', async ({ page }) => {
    const user = await seedLinkedHandoffUser(sql, 'expired')
    const since = await dbNow(sql)
    const nonce = await victimHoldingNonce(page, user)
    expect(await expireNonceRowsSince(sql, since)).toBe(1)
    const rejectedSince = await dbNow(sql)

    await page.goto(`${pvOrigin}/auth/claim#${mintHandoffToken(user, { nonce }).token}`)

    await expectErrorState(page)
    await expectRejectedWith(rejectedSince, ['handoff_nonce_expired'])
    expect(await countSessions(sql, user.userId)).toBe(0)
  })

  test('a token for an unlinked organization is handoff_org_mismatch and the jti is still burned', async ({
    page,
  }) => {
    const user = await seedLinkedHandoffUser(sql, 'wrong-org')
    issuer.plan({
      subject: user,
      mode: 'redirect',
      organizationId: `org_j31_unlinked_${user.userId}`,
    })
    const since = await dbNow(sql)

    await startHandoff(page)

    await expectErrorState(page)
    await expectRejectedWith(since, ['handoff_org_mismatch'])
    expect(await isJtiBurned(sql, lastHit().minted?.jti ?? '')).toBe(true)
    expect(await countSessions(sql, user.userId)).toBe(0)
  })

  test('an MFA-enrolled user gets the MFA form on /auth/claim after the nonce check, with no Confirm button', async ({
    page,
  }) => {
    const user = await seedLinkedHandoffUser(sql, 'mfa', { mfaEnrolled: true })
    issuer.plan({ subject: user, mode: 'redirect' })
    const since = await dbNow(sql)

    await startHandoff(page)

    await expect(page.getByLabel(/authenticator code/i)).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Finish signing in' })).toBeVisible()
    await expect(page.getByRole('button', { name: /confirm/i })).toHaveCount(0)
    expect(page.url()).toBe(`${pvOrigin}/auth/claim`)
    expect(await isJtiBurned(sql, lastHit().minted?.jti ?? '')).toBe(true)
    expect((await nonceRowsSince(sql, since))[0]?.consumedAt).not.toBeNull()
    expect(await securityEventsSince(sql, since)).toEqual([])
    expect(await countSessions(sql, user.userId)).toBe(0)
  })
})

describeEachAppearance('J31 — /auth/claim states (AC3, AC6)', (appearance) => {
  test('the error state: heading, generic alert, no buttons, no sideways scroll', async ({
    page,
  }) => {
    await page.goto(`${pvOrigin}/auth/claim`)

    await expectErrorState(page)
    await expectAppearanceApplied(page, appearance)
    await expectNoHorizontalOverflow(page)
  })

  test('the MFA state: heading, code field, no Confirm button, no sideways scroll', async ({
    page,
  }) => {
    const user = await seedLinkedHandoffUser(sql, `mfa-${appearance.colorScheme}`, {
      mfaEnrolled: true,
    })
    issuer.plan({ subject: user, mode: 'redirect' })

    await startHandoff(page)

    await expect(page.getByRole('heading', { level: 1, name: 'Finish signing in' })).toBeVisible()
    await expect(page.getByLabel(/authenticator code/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /confirm/i })).toHaveCount(0)
    await expectAppearanceApplied(page, appearance)
    await expectNoHorizontalOverflow(page)
  })
})
