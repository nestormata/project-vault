import { expect, test } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { setPlatformOperatorViaDb } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

// J29 — Story 43.7 AC-7: the real stack renders the real CLI version policy on
// /platform/upgrade for a platform operator, and hides it from a non-operator.
//
// Why this journey promotes via the DB instead of j15/j23's "first user or skip" pattern: the
// platform operator is the FIRST user ever registered, and j1 registers first in file order, so a
// first-user check would make this journey skip in practically every full run — its operator
// assertions would never execute in CI. `setPlatformOperatorViaDb` (setup-only) promotes this
// journey's own user instead; the API re-reads `users.is_platform_operator` on every request, so
// the promotion applies to the already-logged-in session. The schema allows one operator, so the
// helper returns the displaced operator, which `afterAll` restores (the suite runs `workers: 1`).
//
// MFA is deliberately not enrolled: the page's loader gates on `platformOperatorGate` only and
// the policy endpoint is public. (j15/j23's probe, /api/v1/admin/settings, is `requireMfa: true`,
// so it would conflate "not an operator" with "MFA not enrolled"; /auth/me is used instead.)
//
// The e2e api (docker-compose.e2e.yml) is a dev build with CLI_MINIMUM_SUPPORTED_VERSION=1.1.0 and
// CLI_WITHDRAWN_VERSIONS=1.2.1,1.2.2-rc.1. Rate limiting is not exercised here: a 61-request burst
// would starve other journeys sharing the web server's IP (component tests cover that state).

const E2E_PASS_VALUE = 'e2e-J29-Password-123'
const ADMIN_REASON = "Withdrawn by this server's administrator."
const POLICY_PATH = '/api/v1/client-version-policy'

type CliPolicyBody = {
  data: {
    clients: {
      cli: {
        current: string | null
        minimumSupported: string | null
        withdrawn: { version: string; reason: string }[]
      }
    }
  }
}

async function expectPlatformOperator(context: BrowserContext, expected: boolean) {
  const me = await context.request.get('/api/v1/auth/me')
  expect(me.ok(), await me.text()).toBeTruthy()
  const body = (await me.json()) as { data: { isPlatformOperator: boolean } }
  expect(body.data.isPlatformOperator).toBe(expected)
}

test.describe.serial('J29 — CLI version policy on the Version & Upgrade page', () => {
  let displacedOperatorEmail: string | null = null

  test.afterAll(async () => {
    if (displacedOperatorEmail) await setPlatformOperatorViaDb(displacedOperatorEmail, true)
  })

  test('AC-7: an operator sees the effective policy, identical to the endpoint', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j29-operator')
    await registerAndLoginViaApi(context, {
      email,
      password: E2E_PASS_VALUE,
      orgName: uniqueOrgName('J29 Org'),
    })
    const displaced = await setPlatformOperatorViaDb(email, true)
    // Record the operator this worker displaced so afterAll can restore it. `??=` is only a
    // defensive keep-first guard: a Playwright retry runs in a fresh worker (module state is
    // reset), so it does not carry this value across retries.
    displacedOperatorEmail ??= displaced
    await expectPlatformOperator(context, true)

    await page.goto('/platform/upgrade')
    await expect(page.getByRole('heading', { name: 'CLI Version Policy' })).toBeVisible()
    await expect(page.getByTestId('cli-policy-current')).toContainText('development build')
    await expect(page.getByTestId('cli-policy-minimum')).toContainText('1.1.0')

    const table = page.getByRole('table', { name: /withdrawn pvault versions/i })
    const rows = table.locator('tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('1.2.1')
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText(ADMIN_REASON)
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText('1.2.2-rc.1')
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText(ADMIN_REASON)
    await expect(
      page.getByText(/entries with this reason were added through CLI_WITHDRAWN_VERSIONS/i)
    ).toBeVisible()

    // Cross-check against the source of truth, through the web proxy as the page's loader does.
    const policyResponse = await context.request.get(POLICY_PATH)
    expect(policyResponse.status()).toBe(200)
    const { cli } = ((await policyResponse.json()) as CliPolicyBody).data.clients
    expect(cli.current).toBeNull()
    expect(cli.minimumSupported).toBe('1.1.0')
    const shownRows = await rows.evaluateAll((trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())
        return { version: cells[0], reason: cells[1] }
      })
    )
    expect(shownRows).toEqual(cli.withdrawn)
  })

  test('AC-7: a non-operator org owner sees the access notice and no policy', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const email = uniqueEmail('j29-owner')
      await registerAndLoginViaApi(context, {
        email,
        password: E2E_PASS_VALUE,
        orgName: uniqueOrgName('J29 Owner Org'),
      })
      // Holds even when j29 runs alone on an empty DB, where this user could otherwise be the
      // first-registered operator. Only ever demotes this journey's own user.
      await setPlatformOperatorViaDb(email, false)
      await expectPlatformOperator(context, false)

      // Browser-side sanity check only: the loader fetch is server-side, so the binding proof of
      // AC-5's "no policy request" is the loader unit test.
      const policyRequests: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('client-version-policy')) policyRequests.push(request.url())
      })

      await page.goto('/platform/upgrade')
      await expect(
        page.getByRole('heading', { name: /platform operator access required/i })
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: 'CLI Version Policy' })).toHaveCount(0)
      expect(policyRequests).toEqual([])
    } finally {
      await context.close()
    }
  })
})
