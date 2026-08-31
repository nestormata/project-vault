import { expect, test } from '@playwright/test'

const CONFIRM_URL = '**/api/v1/auth/handoff/confirm'
const CONFIRM_BUTTON_NAME = 'Confirm sign-in'
const GENERIC_REJECTION_MESSAGE = 'Sign-in could not be verified. Please start again.'

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
    await page.route(CONFIRM_URL, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { mfaRequired: true, mfaToken: 'e2e-mfa-token' } }),
      })
    })

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )

    await expect(page.getByRole('heading', { name: CONFIRM_BUTTON_NAME })).toBeVisible()
    await expect(
      page.getByText('Sign in to Project Vault as alex@acme.com in Acme Corp?')
    ).toBeVisible()

    await page.getByRole('button', { name: CONFIRM_BUTTON_NAME }).click()

    // The confirm response's mfaRequired branch renders the existing, unmodified MfaLoginForm.
    await expect(page.getByLabelText(/authenticator code/i)).toBeVisible()
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
    await page.route(CONFIRM_URL, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'handoff_rejected',
          message: GENERIC_REJECTION_MESSAGE,
        }),
      })
    })

    await page.goto(
      '/handoff?pendingId=e2e-fixture-pending-id-2&organizationName=Acme%20Corp&accountLabel=alex%40acme.com'
    )
    await page.getByRole('button', { name: CONFIRM_BUTTON_NAME }).click()

    await expect(page.getByText(GENERIC_REJECTION_MESSAGE)).toBeVisible()
    await expect(page.getByRole('button', { name: CONFIRM_BUTTON_NAME })).toHaveCount(0)
  })
})
