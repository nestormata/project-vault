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

// J28 — Story 30.5's own Testing Requirements: "No true end-to-end CM->PV browser test is
// possible in this repository" (CM is external, not present here, and DW-153 means even a
// fully-wired confirm call against a real database would fail closed for any newly-provisioned
// test org). This journey exercises the actual page-level flow this repo CAN verify: a real
// browser rendering `/handoff` from a hand-built query string (mirroring what CM's interstitial
// is documented, in this story's Background, to produce) and driving the Confirm click against a
// stubbed `POST /api/v1/auth/handoff/confirm` response — the backend contract itself is Story
// 30.2's already-tested responsibility, not this story's (see Dev Notes' Testing Requirements).
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
  // IMPORTANT scope note (recorded per AC6's own explicit instruction to say so rather than
  // silently under-deliver): the claim-exchange consumption itself runs inside `/handoff`'s new
  // SvelteKit `load` (`+page.server.ts`), which calls apps/api's `exchange-claim` endpoint with a
  // plain server-to-server `fetch` — a call this SUITE's Playwright browser context never
  // originates and therefore CANNOT intercept with `page.route` (unlike the CONFIRM_URL stub
  // above, which works because `+page.svelte`'s confirm call is a real in-browser fetch). Proving
  // the happy-path/replay round trip for real additionally requires `VAULT_HANDOFF_ENABLED=true`
  // plus a real Ed25519 signing keypair wired into the e2e stack's `apps/api` — neither is
  // configured for this repo's `make e2e`/`make docker-up` stack today (`.env.example` ships
  // `VAULT_HANDOFF_ENABLED=false`), and standing that up is a meaningfully larger, separate piece
  // of e2e infrastructure work than this story's test-only task. That full round trip (happy path,
  // replay-fails-second-time) is instead already covered, against a real Postgres database, by
  // `apps/api/src/modules/auth/handoff-routes.test.ts`'s `POST /exchange-claim` suite (happy path,
  // replay, expired, malformed/missing claim, unmatched claim, mismatched pendingId/claim pair,
  // rolling-deploy skew, disabled) and by this app's own
  // `apps/web/src/routes/(auth)/handoff/page-server.test.ts` (the `load`'s own branching, mocking
  // the proxied call). This journey instead verifies what IS observable from the browser in the
  // current, unmodified e2e stack: with `VAULT_HANDOFF_ENABLED` off, a `claim` query parameter
  // present on `/handoff` always fails the exchange closed (no `handoff-confirm` cookie from the
  // `load`), and — because `prepare()` unconditionally keeps setting its own cookie (AC6/
  // elicitation Round 5) — the page still renders and completes via the existing, unmodified
  // confirm flow exactly as it did before this story. Per AC6's own instruction: this gap (no real
  // browser-driven happy-path/replay round trip, and no true two-origin cross-site variant either)
  // is being stated explicitly here and in the story's Dev Notes, not silently left uncovered.
  test('a claim query param that fails to exchange never sets a handoff-confirm cookie, and the existing confirm flow still completes unaffected', async ({
    page,
    context,
  }) => {
    await stubMfaChallengeConfirm(page, 'e2e-mfa-token-claim')

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-claim&claim=e2e-fixture-claim-does-not-exchange&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )

    // The load's own exchange attempt fails closed (handoff disabled in this stack) — it must
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
