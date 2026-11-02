import { expect, type BrowserContext, type Page } from '@playwright/test'
import { registerAndLoginViaApi } from './auth.js'
import { expectAppearanceApplied, type Appearance } from './appearance.js'
import { gotoHydrated } from './hydration.js'
import { uniqueEmail, uniqueOrgName } from './ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'

/** Sign in a new owner, open the dashboard, and open the command palette from the keyboard. */
export async function openPaletteOnDashboard(
  page: Page,
  context: BrowserContext,
  appearance: Appearance,
  tag: string
) {
  await registerAndLoginViaApi(context, {
    email: uniqueEmail(`${tag}-owner`),
    password: OWNER_PASSWORD,
    orgName: uniqueOrgName(`${tag} Org`),
  })
  await gotoHydrated(page, '/dashboard', page.getByRole('heading', { name: 'Secret overview' }))
  await expectAppearanceApplied(page, appearance)
  await page.keyboard.press('Control+K')
  const dialog = page.getByRole('dialog', { name: 'Global search' })
  await expect(dialog).toBeVisible()
  return dialog
}
