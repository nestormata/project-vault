import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { createLoginTemplateCredentialViaUi } from '../fixtures/credentials-ui.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'

// J18 — regression test for a genuinely expired session leaving the UI stuck instead of sending
// the user back to /login. Distinct from J14 (session_revoked, refresh succeeds and the mutation
// transparently retries): here the refresh call itself also fails — the browser-side apiFetch
// client (apps/web/src/lib/api/client.ts) must redirect to /login?reason=session-expired rather
// than just throwing into a swallowed form-action error or the generic error boundary.
test.describe('J18 — a client mutation that hits a dead session redirects to /login', () => {
  test('an unrecoverable 401 (refresh also fails) redirects to /login with the session-expired reason', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j18-owner')
    const password = OWNER_PASSWORD
    const orgName = uniqueOrgName('J18 Org')

    await registerAndLoginViaApi(context, { email, password, orgName })

    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J18 Project'),
      slug: `j18-${Date.now()}`,
    })
    const projectId = project.id

    await createLoginTemplateCredentialViaUi(page, projectId, {
      name: 'j18-db-login',
      field1Value: 'svc-account',
      field2Value: 'initial-password',
    })

    await page.getByRole('button', { name: 'Edit fields' }).click()
    await expect(page.getByRole('button', { name: 'Save fields' })).toBeVisible()

    // Kill the session for real, server-side, while the tab still holds its (now stale) cookies —
    // the "session died while the page was open" case. An earlier version faked the two 401s with
    // `page.route` and left the real session alive; since #314 (5d9c33c6, Story 23.2) gave /login a
    // server `load`, the client-side redirect to /login consults the server, which saw that live
    // session and (correctly) bounced the user to /dashboard. With a genuinely revoked session the
    // mutation's 401 and the refresh's 401 are both the real API's answers — no mocks.
    const staleCookies = await context.cookies()
    const logout = await context.request.post('/api/v1/auth/logout')
    expect(logout.status(), await logout.text()).toBe(204)
    await context.addCookies(staleCookies)

    await page.getByRole('button', { name: 'Save fields' }).click()

    await expect(page).toHaveURL(/\/login\?reason=session-expired/)
    await expect(page.getByText('Your session ended. Sign in again to continue.')).toBeVisible()
  })
})
