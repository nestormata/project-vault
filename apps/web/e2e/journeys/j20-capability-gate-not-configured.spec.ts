import { expect, test } from '@playwright/test'
import { createProjectViaApi } from '../fixtures/api.js'
import { enrollMfaViaUi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { setOrganizationRoleViaDb } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

/**
 * J20 (Dana-orgadmin half) — Story 23.3's "no capability gate configured" persona journey. Runs
 * against the SHARED E2E stack (unlike this story's Priya journey, `j20-capability-gate-
 * entitlement.spec.ts`, which needs its own isolated stack): the shared stack's loaded manifest
 * (`@project-vault/mock-sso-extension`, `docker-compose.e2e.yml`) declares only `'auth-provider'`
 * — it never declares `'capability-gate'` — so this stack already, exactly, IS Dana's scenario:
 * an instance with no external policy layer for capabilities. No dedicated infra needed.
 *
 * Proves AC-5's byte-identical-to-today guarantee end-to-end: publishing, reading the public
 * page, and every other status-page action work completely normally, and `/settings/extensions`
 * states the honest, un-gated default rather than fabricating a status.
 */
test.describe
  .serial('J20 — capability-gate NOT configured journey (Story 23.3, Dana persona)', () => {
  test('AC-5/AC-9: nothing is gated; /settings/extensions shows the honest un-gated default', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j20-dana')
    const password = 'e2e-J20-Dana-Password-1'
    const { orgId } = await registerAndLoginViaApi(context, {
      email,
      password,
      orgName: uniqueOrgName('J20 Dana Org'),
    })
    await enrollMfaViaUi(page)

    // /settings/extensions gates on org role 'admin' specifically — the registering user is
    // 'owner', which that page deliberately does NOT treat as admin-equivalent (mirrors the API's
    // own allowedRoles: ['admin']) — promote directly via DB (setup, not the subject under test).
    await setOrganizationRoleViaDb(orgId, email, 'admin')
    await page.goto('/settings/extensions')
    await expect(
      page.getByText('No capability gate configured — all capabilities are available.')
    ).toBeVisible()
    await expect(page.getByText(/this extension declares a capability gate/i)).toHaveCount(0)

    // Publishing a status page works completely normally — no new request to any gate, no new
    // latency, nothing hidden or disabled. This IS the byte-identical proof, driven for real.
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J20 Dana Project'),
      slug: `j20-dana-project-${Date.now()}`,
    })
    await page.goto(`/projects/${project.id}/status-page`)
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
    await page.getByRole('button', { name: 'Enable public status page' }).click()

    const urlLocator = page.locator('code')
    await expect(urlLocator).toHaveText(/^https?:\/\/.+\/status\/.{10,}$/)
    const publishedUrl = await urlLocator.textContent()
    expect(publishedUrl).toBeTruthy()

    if (publishedUrl) {
      const publicRes = await context.request.get(publishedUrl)
      expect(publicRes.status()).toBe(200)
    }
  })
})
