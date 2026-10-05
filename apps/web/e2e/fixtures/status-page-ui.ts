import { expect, type Page } from '@playwright/test'
import { gotoHydrated } from './hydration.js'

/**
 * Shared by every journey that navigates to a project's public-status-page settings and clicks
 * "Enable" through the real UI (J16, J20, ...) — factored out after jscpd flagged the inline
 * goto/click/reveal sequence as a duplicate across specs (`.jscpd.json`'s threshold is 0%, so any
 * literal repeat fails CI). Asserts the page heading and the enable button are visible, clicks
 * enable, and returns the revealed shareable URL — using a stable locator reference rather than
 * reading `.textContent()` immediately after the click, which would race the
 * POST /enable|/regenerate request/DOM update.
 */
export async function enablePublicStatusPageViaUi(page: Page, projectId: string): Promise<string> {
  const enableButton = page.getByRole('button', { name: 'Enable public status page' })
  // A click before hydration falls through to a native submission and never reveals the link.
  await gotoHydrated(page, `/projects/${projectId}/status-page`, enableButton)
  await expect(page.getByRole('heading', { name: 'Public status page' })).toBeVisible()
  await enableButton.click()

  const urlLocator = page.locator('code')
  await expect(urlLocator).toHaveText(/^https?:\/\/.+\/status\/.{10,}$/)
  const url = await urlLocator.textContent()
  expect(url, 'shareable URL must be revealed on enable').toBeTruthy()
  return url as string
}
