import { expect, test } from '@playwright/test'
import { describeEachAppearance, expectNoHorizontalOverflow } from '../fixtures/appearance.js'
import { openPaletteOnDashboard } from '../fixtures/palette.js'

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
    const dialog = await openPaletteOnDashboard(page, context, appearance, 'j47')
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
