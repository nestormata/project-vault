import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'

// J47 (Story 72.18, CM request R3): PV's own build has no results provider, so the palette must
// behave exactly as before the seam existed: native action group, the empty-query state, the plain
// "No results" line for a query nothing matches, no provider heading or failure notice, no overflow.
// The provider behaviour itself (merge, keyboard, navigation, failure, timeout) is proven in the
// composed mechanism suite (`mechanism/m3-search-provider.spec.ts`), where a pack registers one.

describeEachAppearance('J47 global search without providers', (appearance) => {
  test('AC4: the palette keeps its native behaviour and shows nothing from the provider seam', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j47-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J47 Org'),
    })

    await gotoHydrated(page, '/dashboard', page.getByRole('heading', { name: 'Secret overview' }))
    await expectAppearanceApplied(page, appearance)

    await page.keyboard.press('Control+K')
    const dialog = page.getByRole('dialog', { name: 'Global search' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Actions', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'Create project' })).toBeVisible()

    const query = `zz-${Date.now().toString(36)}-nothing`
    await dialog.getByLabel('Search', { exact: true }).fill(query)
    await expect(dialog.getByText(`No results for "${query}"`)).toBeVisible()
    await expect(dialog.getByText('Some results could not be loaded.')).toHaveCount(0)
    await expect(dialog.getByRole('status')).toHaveText('')
    await expectNoHorizontalOverflow(page)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
