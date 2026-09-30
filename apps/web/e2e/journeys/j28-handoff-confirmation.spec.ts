import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const CONFIRM_URL = '**/api/v1/auth/handoff/confirm'
const CONFIRM_BUTTON_NAME = 'Confirm sign-in'
const GENERIC_REJECTION_MESSAGE = 'Sign-in could not be verified. Please start again.'
const HANDOFF_CONFIRM_COOKIE_NAME = 'handoff-confirm'
const ERROR_HEADING = "Sign-in couldn't be completed"
const GUIDANCE = 'Return to CentralizeMe and start signing in again.'

async function stubMfaChallengeConfirm(page: Page, mfaToken: string): Promise<void> {
  await page.route(CONFIRM_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { mfaRequired: true, mfaToken } }),
    })
  })
}

async function stubRejectedConfirm(page: Page): Promise<void> {
  await page.route(CONFIRM_URL, async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'handoff_rejected', message: GENERIC_REJECTION_MESSAGE }),
    })
  })
}

// Story 60.4 AC2/AC3: every terminal error state shows the error heading, the generic alert, the
// plain-text guidance (no VAULT_HANDOFF_ISSUER on this stack's web service), and no Confirm.
async function expectTerminalErrorWithGuidance(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(ERROR_HEADING)
  await expect(page.getByRole('alert')).toHaveText(GENERIC_REJECTION_MESSAGE)
  await expect(page.getByText(GUIDANCE, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to CentralizeMe' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: CONFIRM_BUTTON_NAME })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Not me' })).toHaveCount(0)
}

async function assertNoHandoffCookie(context: BrowserContext): Promise<void> {
  expect((await context.cookies()).some((c) => c.name === HANDOFF_CONFIRM_COOKIE_NAME)).toBe(false)
}

async function confirmAndExpectMfaChallenge(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: CONFIRM_BUTTON_NAME })).toBeVisible()
  await expect(
    page.getByText('Sign in to Project Vault as alex@acme.com in Acme Corp?')
  ).toBeVisible()

  await page.getByRole('button', { name: CONFIRM_BUTTON_NAME }).click()

  // The confirm response's mfaRequired branch renders the existing, unmodified MfaLoginForm.
  await expect(page.getByLabel(/authenticator code/i)).toBeVisible()
}

// J28 — Story 30.5's own testing constraint: no true end-to-end CM->PV browser test is possible
// in this repository (CM is external, not present here, and a newly-provisioned test org has no
// centralizeme_organization_id yet, so even a fully-wired confirm call against a real database
// would fail closed for it). This journey exercises the actual page-level flow this repo CAN
// verify: a real browser rendering `/handoff` from a hand-built query string (mirroring what
// CM's interstitial is documented to produce) and driving the Confirm click against a
// stubbed `POST /api/v1/auth/handoff/confirm` response — the backend contract itself is Story
// 30.2's already-tested responsibility, not this story's.
test.describe('J28 — handoff confirmation page', () => {
  test('renders the resolved account/org and completes a stubbed MFA-challenge login', async ({
    page,
  }) => {
    await stubMfaChallengeConfirm(page, 'e2e-mfa-token')

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )

    await confirmAndExpectMfaChallenge(page)
  })

  test('renders the neutral error state for a direct navigation with no query params', async ({
    page,
  }) => {
    await page.goto('/handoff')

    await expect(page.getByText(GENERIC_REJECTION_MESSAGE)).toBeVisible()
    await expect(page.getByRole('button', { name: CONFIRM_BUTTON_NAME })).toHaveCount(0)
  })

  test('renders the generic rejection message on a stubbed 401, with no retry button', async ({
    page,
  }) => {
    await stubRejectedConfirm(page)

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-2&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )
    await page.getByRole('button', { name: CONFIRM_BUTTON_NAME }).click()

    await expect(page.getByText(GENERIC_REJECTION_MESSAGE)).toBeVisible()
    await expect(page.getByRole('button', { name: CONFIRM_BUTTON_NAME })).toHaveCount(0)
  })

  // Story 60.3 AC6 — Option 1's claim-exchange regression coverage.
  //
  // Scope note. The claim exchange runs inside `/handoff`'s SvelteKit `load` (`+page.server.ts`),
  // which calls apps/api's `exchange-claim` server-to-server: this browser context never sends
  // that request and so cannot stub it with `page.route` (unlike CONFIRM_URL above, a real
  // in-browser fetch). These tests use bogus, never-prepared claims, so the exchange always fails
  // closed (`handoff_replay`) whether or not handoff is enabled, and they check that a failed
  // exchange never sets a `handoff-confirm` cookie and never breaks the pendingId-driven page.
  //
  // Since Story 60.6 the e2e stack runs with handoff ENABLED and a test-only Ed25519 key
  // (docker-compose.e2e.yml). The real round trip (a signed token, a genuinely cross-site
  // `prepare` from a second site, the claim exchange, Confirm, a session, and replay rejection) is
  // covered by `j31-handoff-cross-site-real-token.spec.ts`. The api-level edge cases stay in
  // `apps/api/src/modules/auth/handoff-routes.test.ts` and the `load`'s branching in
  // `apps/web/src/routes/(auth)/handoff/page-server.test.ts`.
  test('a claim query param that fails to exchange never sets a handoff-confirm cookie, and the existing confirm flow still completes unaffected', async ({
    page,
    context,
  }) => {
    await stubMfaChallengeConfirm(page, 'e2e-mfa-token-claim')

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-claim&claim=e2e-fixture-claim-does-not-exchange&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )

    // The load's own exchange attempt fails closed (the claim was never prepared) — it must
    // never set the handoff-confirm cookie itself.
    await assertNoHandoffCookie(context)

    // The page still renders and functions normally — an unexchanged claim param must never break
    // the existing pendingId-driven rendering or the (still prepare()-cookie-backed) confirm flow.
    await confirmAndExpectMfaChallenge(page)
  })

  test('the same unexchangeable claim URL loaded twice is safe both times (no crash, no cookie either time)', async ({
    page,
    context,
  }) => {
    const url =
      '/handoff?pendingId=e2e-fixture-pending-id-claim-2&claim=e2e-fixture-claim-replay&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'

    await page.goto(url)
    await assertNoHandoffCookie(context)
    await expect(page.getByRole('heading', { name: CONFIRM_BUTTON_NAME })).toBeVisible()

    // Second load of the identical URL — mirrors AC3's replay edge case at the level this suite
    // can actually exercise without a real signed claim (see the scope note above): idempotently
    // safe, never a crash, never a cookie either time.
    await page.goto(url)
    await assertNoHandoffCookie(context)
    await expect(page.getByRole('heading', { name: CONFIRM_BUTTON_NAME })).toBeVisible()
  })

  // Story 60.4 (F10/F11). The e2e stack does not set VAULT_HANDOFF_ISSUER on the web service, so
  // the terminal error states render the PLAIN-TEXT guidance here; the linked branch is covered by
  // page.test.ts / page-server.test.ts and the Chrome pass.
  test('60.4 (a): no-params renders the error heading and plain-text CentralizeMe guidance', async ({
    page,
  }) => {
    await page.goto('/handoff')

    await expectTerminalErrorWithGuidance(page)
  })

  test('60.4 (b): a stubbed 401 confirm renders the error heading and guidance', async ({
    page,
  }) => {
    await stubRejectedConfirm(page)

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-604b&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(CONFIRM_BUTTON_NAME)
    await page.getByRole('button', { name: CONFIRM_BUTTON_NAME }).click()

    await expectTerminalErrorWithGuidance(page)
  })

  test('60.4 (c): "Not me" navigates to /login without any handoff API call', async ({ page }) => {
    const handoffRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/auth/handoff/')) handoffRequests.push(request.url())
    })

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-604c&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )
    await expect(page.getByRole('button', { name: CONFIRM_BUTTON_NAME })).toBeVisible()

    await page.getByRole('link', { name: 'Not me' }).click()

    await expect(page).toHaveURL(/\/login(\?|$)/)
    expect(handoffRequests).toEqual([])
  })

  test('60.4 (d): a synthetic service-provisioned accountLabel renders as "your account"', async ({
    page,
  }) => {
    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-604d&organizationName=Acme%20Corp&accountLabel=service-provisioned%2Bab12%40invalid.projectvault'
    )

    await expect(
      page.getByText('Sign in to Project Vault as your account in Acme Corp?')
    ).toBeVisible()
    await expect(page.getByText(/invalid\.projectvault/)).toHaveCount(0)
  })
})
