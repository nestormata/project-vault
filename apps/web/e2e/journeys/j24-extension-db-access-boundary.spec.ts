import { expect, test } from '@playwright/test'
import { enrollMfaViaUi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { setOrganizationRoleViaDb } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

function apiBaseUrl(): string {
  const port = process.env['API_HOST_PORT'] ?? '3000'
  return process.env['E2E_API_BASE_URL'] ?? `http://localhost:${port}`
}

/**
 * J24 — Story 23.5's browser-level regression journey.
 *
 * Story 23.5 has no new user-facing surface: database access is an operator-approved internal
 * capability. This journey therefore proves the boundary from the real browser/API path instead
 * of inventing a UI for grants: the existing extension-status surface remains truthful, contains
 * no connection material, and the public health contract remains free of extension DB details.
 */
test.describe.serial('J24 — extension database access boundary', () => {
  test('AC-19/AC-24: public health stays healthy and never exposes connection configuration', async ({
    request,
  }) => {
    const response = await request.get(`${apiBaseUrl()}/health`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const body = await response.text()
    expect(body).not.toMatch(/EXTENSION_DATABASE_URL|EXTENSION_GRANT_DATABASE_URL|vault_extension/i)
    expect(body).not.toMatch(/dev-only-change-in-prod|postgresql:\/\//i)
  })

  test('AC-12/AC-24: an unauthenticated caller cannot read extension status or DB scope', async ({
    request,
  }) => {
    const response = await request.get(`${apiBaseUrl()}/api/v1/admin/extensions/status`)
    expect(response.status()).toBe(401)
    const body = await response.text()
    expect(body).not.toMatch(/EXTENSION_DATABASE_URL|EXTENSION_GRANT_DATABASE_URL|dbScope/i)
    expect(body).not.toMatch(/dev-only-change-in-prod|postgresql:\/\//i)
  })

  test('AC-12/AC-19: admin extension status stays metadata-only and the existing settings page is truthful', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j24-admin')
    const { orgId } = await registerAndLoginViaApi(context, {
      email,
      password: ['e2e', 'J24', 'Password', '1'].join('-'),
      orgName: uniqueOrgName('J24 Extension DB Org'),
    })
    await enrollMfaViaUi(page)
    await setOrganizationRoleViaDb(orgId, email, 'admin')

    const response = await context.request.get(`${apiBaseUrl()}/api/v1/admin/extensions/status`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const body = (await response.json()) as Record<string, unknown>
    // Exact key set on purpose: any new key on this admin envelope must force a conscious review
    // of the metadata-only boundary. `clockSkew` is Story 30.1's (4aa9e73f) additive AC9 field —
    // a measurement, not connection material; its own keys are pinned below too. `apiRoutes` is
    // Story 68.8 AC-6's additive field (added/override route keys and flags only, zero-valued when
    // no extension declares apiRoutes), pinned in the API contract test as well. Its `app` block (app-level
    // handler/hook behaviour flags, null/empty when no extension declares any) mirrors status-routes.ts.
    expect(Object.keys(body).sort()).toEqual([
      'apiRoutes',
      'clockSkew',
      'extension',
      'nativeLoginPolicy',
    ])
    expect(body['apiRoutes']).toEqual({
      added: [],
      overrides: [],
      app: { errorHandler: null, notFoundHandler: null, hooks: { prepend: [], append: [] } },
    })
    expect(Object.keys(body['clockSkew'] as Record<string, unknown>).sort()).toEqual([
      'lastMeasuredMs',
      'measuredAt',
      'status',
      'warnThresholdMs',
    ])
    expect(JSON.stringify(body)).not.toMatch(
      /EXTENSION_DATABASE_URL|EXTENSION_GRANT_DATABASE_URL|dbScope|vault_extension|dev-only-change-in-prod|postgresql:\/\//i
    )

    await page.goto('/settings/extensions')
    await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible()
    const rendered = await page.locator('body').innerText()
    expect(rendered).toMatch(/No extension configured|Loaded|failed to load/i)
    expect(rendered).not.toMatch(
      /EXTENSION_DATABASE_URL|EXTENSION_GRANT_DATABASE_URL|dbScope|vault_extension|dev-only-change-in-prod|postgresql:\/\//i
    )
  })
})
