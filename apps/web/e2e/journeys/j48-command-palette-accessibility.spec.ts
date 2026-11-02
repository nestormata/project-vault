import { expect, test } from '@playwright/test'
import { describeEachAppearance, expectNoHorizontalOverflow } from '../fixtures/appearance.js'
import { openPaletteOnDashboard } from '../fixtures/palette.js'

const ACTIVE_ROW = 'aria-activedescendant'

// Keyboard-only command palette: the search field points at the active row, every row has its
// own id, and a polite live region announces how many rows can be reached (or that there are none).
describeEachAppearance('J48 command palette accessibility', (appearance) => {
  test('arrow keys follow the active row and the count is announced', async ({ page, context }) => {
    const dialog = await openPaletteOnDashboard(page, context, appearance, 'j48')

    const input = dialog.getByRole('combobox', { name: 'Search' })
    const options = dialog.getByRole('option')
    await expect(options.nth(1)).toBeVisible()
    const ids = await options.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('global-search-option-'))).toBe(true)

    const selected = dialog.locator('[role="option"][aria-selected="true"]')
    await expect(selected).toHaveAttribute('id', ids[0] ?? '')
    await expect(input).toHaveAttribute(ACTIVE_ROW, ids[0] ?? '')
    await expect(input).toHaveAttribute('aria-expanded', 'true')
    await expect(input).toHaveAttribute('aria-controls', 'global-search-results')

    const live = dialog.locator('#global-search-result-count')
    await expect(live).toHaveAttribute('aria-live', 'polite')
    await expect(live).toHaveAttribute('aria-atomic', 'true')
    await expect(live).toHaveText(`${ids.length} results`)

    await page.keyboard.press('ArrowDown')
    await expect(input).toHaveAttribute(ACTIVE_ROW, ids[1] ?? '')
    await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveAttribute(
      'id',
      ids[1] ?? ''
    )

    const query = `zz-${Date.now().toString(36)}-nothing`
    await input.focus()
    await page.keyboard.type(query)
    await expect(live).toHaveText('No results')
    await expect(dialog.getByText(`No results for "${query}"`)).toBeVisible()
    await expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(await input.getAttribute(ACTIVE_ROW)).toBeNull()
    await expect(dialog.getByRole('status')).toHaveText('')
    await expectNoHorizontalOverflow(page)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
