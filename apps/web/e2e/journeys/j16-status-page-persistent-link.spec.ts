import { expect, test } from '@playwright/test'
import { createProjectViaApi } from '../fixtures/api.js'
import { enrollMfaViaUi, registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

// J16: Story 6.6 AC-7's Playwright-specific requirement — "web unit/component coverage and
// Playwright coverage for reload, copy, and explicit rotation confirmation" — on top of the
// already-existing API/web unit+component suites (which cover persistence, migration, and
// replay/concurrency at the service/component level). This spec exercises the realistic day-1 UI
// journey only: enable -> reload persists the same link -> copy gives visible feedback -> the
// two-step regenerate confirm genuinely gates the rotation. Legacy-row and sealed-vault distinct
// copy are deliberately NOT covered here (already covered by API service tests and web component
// tests per the story's Dev Notes) — forcing those states into a live e2e run would add fragile
// setup for no real marginal coverage.
test.describe.serial('J16 — public status page persistent link journey', () => {
  test('AC-1/AC-3/AC-6/AC-7: enable, reload persistence, copy, explicit two-step rotation', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j16-owner')
    const password = 'e2e-J16-Password-123'
    await registerAndLoginViaApi(context, { email, password, orgName: uniqueOrgName('J16 Org') })
    await enrollMfaViaUi(page)

    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J16 Project'),
      slug: `j16-project-${Date.now()}`,
    })

    await page.goto(`/projects/${project.id}/status-page`)
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()

    // Enable.
    await page.getByRole('button', { name: 'Enable public status page' }).click()

    // A stable locator reference — reading `.textContent()` immediately after a click races the
    // POST /enable|/regenerate request/DOM update, matching j15's own tokenLocator convention.
    const urlLocator = page.locator('code')
    await expect(urlLocator).toHaveText(/^https?:\/\/.+\/status\/.{10,}$/)
    const initialUrl = await urlLocator.textContent()
    expect(initialUrl, 'shareable URL must be revealed on enable').toBeTruthy()

    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
    // AC-1: this is a persistent link, not a one-time reveal — no "shown once" style warning.
    await expect(page.getByText(/shown once/i)).toHaveCount(0)

    // Reload — a full page reload re-fetches config via GET .../status-page, proving the token
    // round-trips through the server rather than only surviving in client-side state.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
    await expect(urlLocator).toHaveText(initialUrl ?? '')

    // Copy. The "Copied!" label flip only happens after navigator.clipboard.writeText()
    // resolves (+page.svelte's copyUrl has no catch), so unlike j15's "best-effort" click (which
    // never asserts on the resulting label), this spec explicitly grants clipboard-write first —
    // Chromium-only permission, matching this suite's Chromium-only project config.
    await context.grantPermissions(['clipboard-write', 'clipboard-read'])
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()

    // Regenerate — first click only arms the confirm state; the API call must NOT fire yet.
    const regenerateButton = page.getByRole('button', { name: 'Regenerate link' })
    await regenerateButton.click()
    const confirmButton = page.getByRole('button', {
      name: 'Confirm — old link stops working?',
    })
    await expect(confirmButton).toBeVisible()
    await expect(urlLocator).toHaveText(initialUrl ?? '')

    // Second click on the same control (now showing the confirm label) fires the real rotation.
    await confirmButton.click()
    await expect(page.getByRole('button', { name: 'Regenerate link' })).toBeVisible()
    await expect(urlLocator).not.toHaveText(initialUrl ?? '')
    const rotatedUrl = await urlLocator.textContent()
    expect(rotatedUrl).toBeTruthy()
    expect(rotatedUrl).not.toBe(initialUrl)

    // Optional real-request check: the old link's page still returns 200 (SvelteKit page shell)
    // but renders status/[token]'s own "not available" state rather than the status data, per
    // apps/web/src/routes/status/[token]/+page.svelte — confirming rotation genuinely invalidated
    // the old token server-side rather than only updating the admin UI.
    if (initialUrl) {
      const oldLinkResponse = await context.request.get(initialUrl)
      expect(oldLinkResponse.ok()).toBeTruthy()
      const oldLinkPage = await oldLinkResponse.text()
      expect(oldLinkPage).toContain('Status page not available')
    }
  })
})
