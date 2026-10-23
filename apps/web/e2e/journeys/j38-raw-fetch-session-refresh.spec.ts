import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

// J38 (Story 62-6): the raw-fetch API helpers (here: project export, a binary body with the
// one-time key in a response header) follow the 61-3 session-refresh contract. No mocks: the
// access-token cookie is really removed from the browser context (the refresh-token cookie stays),
// so the API's own 401 `access_token_missing` and its real refresh drive the behaviour.
const PASSWORD = ['e2e', 'J38', 'Owner', 'Password', '123'].join('-')
const ACCESS_COOKIE = 'access-token'
const REFRESH_COOKIE = 'refresh-token'

test.describe('J38 — raw-fetch helpers refresh an expired access cookie', () => {
  test('export succeeds silently when only the access cookie is gone', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j38-owner'),
      password: PASSWORD,
      orgName: uniqueOrgName('J38 Org'),
    })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J38 Project'),
      slug: `j38-${Date.now()}`,
    })
    await createCredentialViaApi(context, project.id, { name: 'j38-secret', value: 'j38-value' })

    const exportButton = page.getByRole('button', { name: 'Export project' })
    await gotoHydrated(page, `/projects/${project.id}`, exportButton)
    await context.clearCookies({ name: ACCESS_COOKIE })

    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])

    expect(download.suggestedFilename()).toMatch(/\.pvexport$/)
    await expect(page.locator('code')).toBeVisible()
    await expect(page.getByText('Access token is missing')).toHaveCount(0)
  })

  test('export with both cookies gone lands on /login once with the session-expired reason', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j38b-owner'),
      password: PASSWORD,
      orgName: uniqueOrgName('J38b Org'),
    })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J38b Project'),
      slug: `j38b-${Date.now()}`,
    })

    const exportButton = page.getByRole('button', { name: 'Export project' })
    await gotoHydrated(page, `/projects/${project.id}`, exportButton)
    await context.clearCookies({ name: ACCESS_COOKIE })
    await context.clearCookies({ name: REFRESH_COOKIE })

    await exportButton.click()

    await expect(page).toHaveURL(/\/login\?reason=session-expired/)
    await expect(page.getByText('Your session ended. Sign in again to continue.')).toBeVisible()
  })
})
