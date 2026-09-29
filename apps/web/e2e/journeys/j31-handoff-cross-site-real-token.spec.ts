import postgres from 'postgres'
import { generateKeyPairSync } from 'node:crypto'
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Response,
  type TestInfo,
} from '@playwright/test'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import {
  countLoginSucceededAudit,
  countPendingStatesForJti,
  countSessions,
  dbNow,
  handoffStubPort,
  isClaimBurned,
  isJtiBurned,
  mintHandoffToken,
  securityEventsSince,
  seedLinkedHandoffUser,
  startCmStub,
  type CmStub,
  type SeededHandoffUser,
} from '../fixtures/handoff.js'

// J31 (Story 60.6): the REAL CentralizeMe -> PV handoff against the live e2e stack. A token signed
// with the stack's test-only key (fixtures/handoff-test-key.ts) goes through a genuinely
// cross-site `prepare` from a fake CM interstitial on http://127.0.0.1:<stub port> (a different
// site from PV's http://localhost:<port>), a top-level navigation to /handoff (the claim
// exchange runs in its server-side load), Confirm, and a real session. This is the regression
// guard for bug F2: the browser must still DROP prepare's cross-site cookie (asserted below, so
// the harness can never silently go same-site) and the flow must still complete without it.
//
// Rules for this file (E5): no page.route/context.route on /api/v1/auth/handoff/** (the real round
// trip is the point); every DB assertion is keyed by the seeded user/org, a pendingId or the
// minted jti; a rendered page is never evidence on its own. Chromium only (DW-315). The stub
// models a top-level navigation; CM's real mechanism is unconfirmed (DW-336 item 1).
//
// Traces/videos kept on failure contain a token and a claim. That is acceptable: test-only key,
// 30 s token, 120 s claim, audience pv:pv-e2e only (E3d).
//
// Not covered here (already covered by real-Postgres api tests, or out of scope, E4): expired or
// oversize tokens, clock skew, concurrent double exchange (60-5), MFA-enrolled users.

const PREPARE_PATH = '/api/v1/auth/handoff/prepare'
const CONFIRM_PATH = '/api/v1/auth/handoff/confirm'
const HANDOFF_COOKIE = 'handoff-confirm'
const CONFIRM_BUTTON = 'Confirm sign-in'
const GENERIC_REJECTION = 'Sign-in could not be verified. Please start again.'

let sql: postgres.Sql
let stub: CmStub
let pvOrigin: string

function pvOriginFrom(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL
  if (!baseURL) throw new Error('j31: playwright.config.ts must set use.baseURL')
  return new URL(baseURL).origin
}

test.beforeAll(async () => {
  pvOrigin = pvOriginFrom(test.info())
  sql = postgres(superuserDatabaseUrl(), { max: 1 })
  stub = await startCmStub({ port: handoffStubPort(), pvOrigin })
})

test.afterAll(async () => {
  await stub?.close()
  await sql?.end({ timeout: 5 })
})

async function hasHandoffCookie(context: BrowserContext): Promise<boolean> {
  return (await context.cookies(pvOrigin)).some((cookie) => cookie.name === HANDOFF_COOKIE)
}

type StubRun = {
  status: string
  statusText: string
  prepareResponses: Response[]
  continueHref: string | null
}

/** Opens the fake interstitial with the token in the fragment and waits for prepare to settle. */
async function runStub(page: Page, stubOrigin: string, token: string): Promise<StubRun> {
  const prepareResponses: Response[] = []
  const record = (response: Response) => {
    if (new URL(response.url()).pathname === PREPARE_PATH) prepareResponses.push(response)
  }
  page.on('response', record)
  await page.goto(`${stubOrigin}/#token=${encodeURIComponent(token)}`)
  const status = page.locator('#status')
  await expect(status).toHaveAttribute('data-status', /.+/)
  page.off('response', record)
  const continueLink = page.locator('#continue')
  return {
    status: (await status.getAttribute('data-status')) ?? '',
    statusText: (await status.textContent()) ?? '',
    prepareResponses,
    continueHref: (await continueLink.count()) > 0 ? await continueLink.getAttribute('href') : null,
  }
}

/** The golden prepare: fails with a CORS_ALLOWED_ORIGINS message instead of timing out (AC3). */
async function prepareCrossSite(
  page: Page,
  token: string
): Promise<{ run: StubRun; href: string }> {
  const run = await runStub(page, stub.origin, token)
  if (run.status === 'fetch-error') {
    throw new Error(
      `The cross-site prepare from ${stub.origin} was blocked (${run.statusText}). Is it in the ` +
        "e2e web service's CORS_ALLOWED_ORIGINS (docker-compose.e2e.yml, E2E_HANDOFF_STUB_PORT)?"
    )
  }
  expect(run.status, run.statusText).toBe('200')
  expect(run.continueHref, 'the stub renders the continue link after a 200 prepare').not.toBeNull()
  return { run, href: run.continueHref ?? '' }
}

function prepareCall(run: StubRun): Response {
  const post = run.prepareResponses.find((response) => response.request().method() === 'POST')
  expect(post, 'the browser sent the prepare POST').toBeDefined()
  return post as Response
}

function handoffParams(href: string): { pendingId: string; claim: string } {
  const url = new URL(href)
  return {
    pendingId: url.searchParams.get('pendingId') ?? '',
    claim: url.searchParams.get('claim') ?? '',
  }
}

/** A top-level navigation to /handoff (a real link click), returning the document response. */
async function followContinueLink(page: Page): Promise<Response> {
  const documentResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/handoff' &&
      response.request().resourceType() === 'document'
  )
  await page.locator('#continue').click()
  const response = await documentResponse
  await page.waitForURL(/\/handoff\?/)
  return response
}

async function clickConfirm(page: Page): Promise<Response> {
  const confirmResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === CONFIRM_PATH
  )
  await page.getByRole('button', { name: CONFIRM_BUTTON }).click()
  return confirmResponse
}

async function expectGenericRejection(page: Page): Promise<void> {
  await expect(page.getByRole('alert')).toHaveText(GENERIC_REJECTION)
  await expect(page.getByRole('button', { name: CONFIRM_BUTTON })).toHaveCount(0)
}

async function expectConsentFor(page: Page, user: SeededHandoffUser): Promise<void> {
  await expect(page.getByRole('heading', { name: CONFIRM_BUTTON })).toBeVisible()
  await expect(
    page.getByText(`Sign in to Project Vault as ${user.email} in ${user.organizationName}?`)
  ).toBeVisible()
}

/** Confirm on the consent page, then land on a signed-in /dashboard for `user`. */
async function confirmIntoDashboard(page: Page, user: SeededHandoffUser): Promise<void> {
  const confirm = await clickConfirm(page)
  expect(confirm.status()).toBe(200)
  const body = (await confirm.json()) as { data: { userId: string; orgId: string } }
  expect(body.data.orgId).toBe(user.orgId)
  expect(body.data.userId).toBe(user.userId)
  await page.waitForURL('**/dashboard')
  // The signed-in app shell names the seeded org (a first-run onboarding dialog overlays the page).
  await expect(page.getByText(`Org: ${user.organizationName}`)).toBeVisible()
  // E5e: the dashboard must not merely look signed in. /auth/me with this page's cookies.
  const me = await page.request.get('/api/v1/auth/me')
  expect(me.status()).toBe(200)
  const meBody = (await me.json()) as { data: { userId: string; orgId: string } }
  expect(meBody.data.userId).toBe(user.userId)
  expect(meBody.data.orgId).toBe(user.orgId)
}

function expectNoRawSecrets(events: { payload: unknown }[], ...secrets: string[]): void {
  const serialized = JSON.stringify(events.map((event) => event.payload))
  for (const secret of secrets) expect(serialized).not.toContain(secret)
}

test.describe('J31 — real-token cross-site handoff: golden path and replay', () => {
  test.describe.configure({ mode: 'serial' })

  // Shared across the serial chain. `retries` re-runs the whole chain with a fresh seed (E1d).
  let goldenContext: BrowserContext
  let user: SeededHandoffUser
  let handoffUrl: string
  let pendingId: string
  let claim: string
  let jti: string

  test.beforeAll(async ({ browser }) => {
    goldenContext = await browser.newContext()
  })

  test.afterAll(async () => {
    await goldenContext?.close()
  })

  /** AC4: the exchange (in the load) and Confirm were both rejected as replays; no new session. */
  async function confirmAndExpectReplayRejected(page: Page, since: Date): Promise<void> {
    const confirm = await clickConfirm(page)
    expect(confirm.status()).toBe(401)
    await expectGenericRejection(page)

    const events = await securityEventsSince(sql, since)
    expect(events.map((e) => e.eventType)).toEqual(['handoff_replay', 'handoff_replay'])
    expectNoRawSecrets(events, claim, pendingId)
    expect(await countSessions(sql, user.userId)).toBe(1)
  }

  test('AC3: a cross-site prepare (cookie dropped) + top-level navigation ends on /dashboard with one real session', async () => {
    user = await seedLinkedHandoffUser(sql, 'golden')
    const page = await goldenContext.newPage()
    // E5b: a fresh context with no PV cookies at all, so nothing but the handoff can sign it in.
    expect(await goldenContext.cookies(pvOrigin)).toEqual([])

    const minted = mintHandoffToken(user)
    jti = minted.jti
    const { run, href } = await prepareCrossSite(page, minted.token)
    handoffUrl = href
    ;({ pendingId, claim } = handoffParams(href))
    expect(pendingId).not.toBe('')
    expect(claim).not.toBe('')

    // AC3.1: the POST carried Set-Cookie and a CORS grant for the stub origin...
    const post = prepareCall(run)
    expect(post.status()).toBe(200)
    expect(await post.headerValue('access-control-allow-origin')).toBe(stub.origin)
    expect(await post.headerValue('access-control-allow-credentials')).toBe('true')
    const setCookies = (await post.headersArray()).filter(
      (header) => header.name.toLowerCase() === 'set-cookie'
    )
    expect(setCookies.some((header) => header.value.startsWith(`${HANDOFF_COOKIE}=`))).toBe(true)
    // ...but the browser dropped it (F2). If this fails, the harness has gone same-site.
    expect(await hasHandoffCookie(goldenContext)).toBe(false)

    // AC3.2: the load's claim exchange sets the cookie same-site.
    const documentResponse = await followContinueLink(page)
    expect(await documentResponse.headerValue('referrer-policy')).toBe('strict-origin')
    await expectConsentFor(page, user)
    expect(await hasHandoffCookie(goldenContext)).toBe(true)
    expect(await isClaimBurned(sql, pendingId)).toBe(true)

    // AC3.3
    await confirmIntoDashboard(page, user)

    // AC3.4: DB evidence, keyed by the seeded user/org, the pendingId and the minted jti.
    expect(await isJtiBurned(sql, jti)).toBe(true)
    expect(await countSessions(sql, user.userId)).toBe(1)
    expect(await countLoginSucceededAudit(sql, user)).toBe(1)
    await page.close()
  })

  test('AC4a: replaying the same URL in a fresh context is rejected at both steps, no new session', async ({
    browser,
  }) => {
    const attacker = await browser.newContext()
    try {
      const page = await attacker.newPage()
      const since = await dbNow(sql)
      await page.goto(handoffUrl)
      // The page still renders from the query string; the load set no cookie (claim burned).
      await expect(page.getByRole('heading', { name: CONFIRM_BUTTON })).toBeVisible()
      expect(await hasHandoffCookie(attacker)).toBe(false)
      const exchangeEvents = (await securityEventsSince(sql, since)).map((e) => e.eventType)
      expect(exchangeEvents).toEqual(['handoff_replay'])

      await confirmAndExpectReplayRejected(page, since)
    } finally {
      await attacker.close()
    }
  })

  test('AC4b: replaying the same URL in the signed-in golden context is rejected (jti burned), no new session', async () => {
    const page = await goldenContext.newPage()
    const since = await dbNow(sql)
    await page.goto(handoffUrl)
    // E2d: /handoff does not redirect an already-authenticated browser; it renders the consent page.
    await expect(page).toHaveURL(/\/handoff\?/)
    await expect(page.getByRole('heading', { name: CONFIRM_BUTTON })).toBeVisible()

    // The exchange is rejected (claim burned) and so is confirm: the golden cookie still maps to
    // the live pending row, but its jti is already burned. Pin the cookie's presence so this case
    // can't silently degrade into AC4a's "no cookie" path (both emit handoff_replay).
    expect(await hasHandoffCookie(goldenContext)).toBe(true)
    await confirmAndExpectReplayRejected(page, since)
    await page.close()
  })
})

test.describe('J31 — real-token negative cases (AC6)', () => {
  test('a token signed by a different key under the same kid is rejected at prepare', async ({
    page,
    context,
  }) => {
    const user = await seedLinkedHandoffUser(sql, 'wrong-key')
    const since = await dbNow(sql)
    const otherKey = generateKeyPairSync('ed25519').privateKey
    const minted = mintHandoffToken(user, { signingKey: otherKey })

    const run = await runStub(page, stub.origin, minted.token)

    expect(run.status).toBe('401')
    expect(run.continueHref).toBeNull()
    expect(await countPendingStatesForJti(sql, minted.jti)).toBe(0)
    expect(await hasHandoffCookie(context)).toBe(false)
    const events = await securityEventsSince(sql, since)
    expect(events.map((e) => e.eventType)).toEqual(['handoff_signature_invalid'])
    expectNoRawSecrets(events, minted.token)
    expect(await countSessions(sql, user.userId)).toBe(0)
  })

  test('a token for an unlinked organization exchanges, then Confirm is rejected and the jti is burned', async ({
    page,
    context,
  }) => {
    const user = await seedLinkedHandoffUser(sql, 'wrong-org')
    const minted = mintHandoffToken(user, { organizationId: `org_j31_unlinked_${user.userId}` })
    const { href } = await prepareCrossSite(page, minted.token)
    const { pendingId, claim } = handoffParams(href)

    await followContinueLink(page)
    expect(await hasHandoffCookie(context)).toBe(true)
    expect(await isClaimBurned(sql, pendingId)).toBe(true)

    const since = await dbNow(sql)
    const confirm = await clickConfirm(page)
    expect(confirm.status()).toBe(401)
    await expectGenericRejection(page)

    // AC4.11/4.12: the burn happens before the org check.
    expect(await isJtiBurned(sql, minted.jti)).toBe(true)
    const events = await securityEventsSince(sql, since)
    expect(events.map((e) => e.eventType)).toEqual(['handoff_org_mismatch'])
    expectNoRawSecrets(events, claim, minted.token)
    expect(await countSessions(sql, user.userId)).toBe(0)
  })

  test('a tampered claim burns nothing, and the untampered link still completes (E4)', async ({
    page,
    context,
  }) => {
    const user = await seedLinkedHandoffUser(sql, 'tampered')
    const minted = mintHandoffToken(user)
    const { href } = await prepareCrossSite(page, minted.token)
    const { pendingId } = handoffParams(href)

    const tampered = new URL(href)
    tampered.searchParams.set('claim', Buffer.alloc(32, 0x31).toString('base64url'))
    await page.goto(tampered.href)
    expect(await hasHandoffCookie(context)).toBe(false)
    expect(await isClaimBurned(sql, pendingId)).toBe(false)

    const confirm = await clickConfirm(page)
    expect(confirm.status()).toBe(401)
    await expectGenericRejection(page)
    expect(await isJtiBurned(sql, minted.jti)).toBe(false)
    expect(await countSessions(sql, user.userId)).toBe(0)

    // The legitimate link is unharmed.
    await page.goto(href)
    await expectConsentFor(page, user)
    expect(await hasHandoffCookie(context)).toBe(true)
    await confirmIntoDashboard(page, user)
    expect(await isJtiBurned(sql, minted.jti)).toBe(true)
    expect(await countSessions(sql, user.userId)).toBe(1)
  })

  test('a prepare from a second, non-allowlisted site is refused by the web and never reaches the api', async ({
    page,
    request,
  }) => {
    const user = await seedLinkedHandoffUser(sql, 'not-allowlisted')
    const other = await startCmStub({ port: handoffStubPort() + 1, pvOrigin })
    try {
      const since = await dbNow(sql)
      const minted = mintHandoffToken(user)

      const run = await runStub(page, other.origin, minted.token)
      expect(run.status, run.statusText).toBe('fetch-error')
      expect(run.prepareResponses.some((response) => response.status() === 200)).toBe(false)

      // The same request outside the browser's CORS machinery gets the web's own 403.
      const direct = await request.post(`${pvOrigin}${PREPARE_PATH}`, {
        headers: { origin: other.origin, 'content-type': 'application/json' },
        data: { token: minted.token },
      })
      expect(direct.status()).toBe(403)

      // 60.1: short-circuited before the api, so no pending row and no security event.
      expect(await countPendingStatesForJti(sql, minted.jti)).toBe(0)
      expect(await securityEventsSince(sql, since)).toEqual([])
    } finally {
      await other.close()
    }
  })
})
