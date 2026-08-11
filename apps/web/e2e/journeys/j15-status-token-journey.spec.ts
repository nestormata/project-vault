import { expect, test } from '@playwright/test'
import { enrollMfaViaUi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

// GET /status is mounted at the API's own root (apps/api/src/app.ts), NOT under /api/v1/* —
// unlike every other endpoint this suite's fixtures/api.ts helpers call, it is deliberately not
// proxied through the web app's server-side /api/v1/[...path] passthrough (playwright.config.ts's
// baseURL is the web origin). A bare `context.request.get('/status', ...)` therefore resolves
// against the web app and hits SvelteKit's own 404, not the API's. This mirrors
// global-setup.ts's apiBaseUrl() so the "real browser request to the endpoint" AC-9 requirement
// actually exercises the API directly, the same way docs/runbook.md's own curl examples do.
const STATUS_TOKEN_STATE_TESTID = 'status-token-state'

function apiBaseUrl(): string {
  const apiHostPort = process.env['API_HOST_PORT'] ?? '3000'
  return process.env['E2E_API_BASE_URL'] ?? `http://localhost:${apiHostPort}`
}

// J15: Story 1.19 AC-5/AC-6/AC-9. Generate -> copy -> test -> rotate -> revoke the GET /status
// bearer token from Settings, as a platform operator, plus one real request to GET /status.
//
// Known limitation (documented rather than silently flaky): "platform operator" is granted to
// the FIRST user EVER registered on the instance (D1), and this repo has no UI/API path to
// self-promote otherwise (by design — see registerPlatformOperator's rationale in
// apps/api/src/__tests__/helpers/platform-operator-test-helpers.ts, which solves this the same
// way for API-level integration tests by directly writing to the DB, an escape hatch not
// available to a browser-driven Playwright spec). This spec therefore only asserts the full
// journey when its own registration happens to land that slot (typically true on a freshly
// reset E2E database with no other platform-admin journey ahead of it in file order) and skips
// itself with a clear reason otherwise, rather than falsely reporting a failure that is really
// "some other journey/worker registered first."
test.describe.serial('J15 — operational status token journey', () => {
  test('AC-5/AC-6: generate, test, rotate, revoke the GET /status token; real GET /status request', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j15-operator')
    const password = 'e2e-J15-Password-123'
    await registerAndLoginViaApi(context, { email, password, orgName: uniqueOrgName('J15 Org') })
    await enrollMfaViaUi(page)

    const settingsCheck = await context.request.get('/api/v1/admin/settings')
    if (settingsCheck.status() === 403) {
      test.skip(
        true,
        'This registration did not land the instance-wide "first user" platform-operator ' +
          'bootstrap slot (see file-level comment) — skipping rather than failing.'
      )
    }
    expect(settingsCheck.ok(), await settingsCheck.text()).toBeTruthy()

    await page.goto('/platform/settings')
    await expect(page.getByRole('heading', { name: 'System Settings' })).toBeVisible()

    // Baseline: not configured.
    await expect(page.getByTestId(STATUS_TOKEN_STATE_TESTID)).toHaveText(/not configured/i)

    // A stable locator reference — reading `.textContent()` immediately after a click races the
    // POST /generate|/rotate request/DOM update (the <code> element is the same DOM node before
    // and after rotate, so an unwaited read can capture the pre-rotate text). `expect(...).
    // toHaveText(...)` polls until the assertion holds, so pairing it with each click below is
    // what actually waits for the new plaintext to land before reading it.
    const tokenLocator = page
      .locator('code')
      .filter({ hasText: /.{20,}/ })
      .first()

    // Generate.
    await page.getByRole('button', { name: 'Generate token' }).click()
    await expect(tokenLocator).toHaveText(/.{20,}/)
    const revealedToken = await tokenLocator.textContent()
    expect(revealedToken, 'plaintext token must be revealed exactly once').toBeTruthy()
    await expect(page.getByTestId(STATUS_TOKEN_STATE_TESTID)).toHaveText(/^configured$/i)

    // Copy (best-effort — clipboard permissions vary by CI environment; the button must at
    // least be present and clickable without throwing).
    await page.getByRole('button', { name: /copy/i }).click()

    // Test (in-process check, exercised via the Settings UI's own POST .../test action).
    await page.getByRole('button', { name: 'Test' }).click()
    await expect(page.getByText(/^Result:/)).toBeVisible()

    // Real request to GET /status from the browser context, with the generated token.
    const statusRes = await context.request.get(`${apiBaseUrl()}/status`, {
      headers: { Authorization: `Bearer ${revealedToken}` },
    })
    expect([200, 503]).toContain(statusRes.status())
    const statusBody = (await statusRes.json()) as { status: string; checks: unknown }
    expect(['healthy', 'degraded', 'unavailable']).toContain(statusBody.status)

    // Unauthenticated remote-shaped request (no token) must not succeed once a token exists.
    const unauthedRes = await context.request.get(`${apiBaseUrl()}/status`)
    expect(unauthedRes.status()).toBe(401)

    // Rotate — old token is invalidated, a new one is shown.
    await page.getByRole('button', { name: 'Rotate token' }).click()
    await expect(tokenLocator).not.toHaveText(revealedToken ?? '')
    const rotatedToken = await tokenLocator.textContent()
    expect(rotatedToken).toBeTruthy()
    expect(rotatedToken).not.toBe(revealedToken)

    const oldTokenRes = await context.request.get(`${apiBaseUrl()}/status`, {
      headers: { Authorization: `Bearer ${revealedToken}` },
    })
    expect(oldTokenRes.status()).toBe(401)

    // Revoke — reverts to the safe unconfigured default.
    await page.getByRole('button', { name: 'Revoke' }).click()
    await expect(page.getByTestId(STATUS_TOKEN_STATE_TESTID)).toHaveText(/not configured/i)
  })
})
