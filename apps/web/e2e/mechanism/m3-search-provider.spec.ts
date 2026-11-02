import { expect, test, type Page } from '@playwright/test'
import { open, seedOrgOwner, trackHydrationMismatch } from './fixtures.js'

// Story 72.18 (CM request R3): the mock pack fills `app.layout.search` and, from that fill, registers
// a results provider with PV's own GlobalSearch (no replacement of the palette). Proves in a composed
// product: provider results appear after the native ones under the provider group, a keyboard
// selection navigates, an action result runs, a failing provider leaves the palette working with a
// calm notice, and a provider that never answers is cut off by its timeout.
const SEARCH = 'mock-p6-layout-search'
const DIALOG = 'Global search'
const searchInput = (page: Page) => page.getByLabel('Search', { exact: true })
const BILLING_ROW = 'Mock Billing page'

test.describe('GlobalSearch results provider seam (M3 fill of app.layout.search)', () => {
  test('works: a provider result is merged, keyboard-selected and navigates; an action runs', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p72-18-search')
    await open(page, '/settings', page.getByTestId(SEARCH))

    await page.keyboard.press('Control+K')
    const dialog = page.getByRole('dialog', { name: DIALOG })
    await expect(dialog).toBeVisible()
    await searchInput(page).fill('mockpack')

    const options = dialog.getByRole('option')
    await expect(dialog.getByText('Mock pack', { exact: true })).toBeVisible()
    await expect(options.filter({ hasText: BILLING_ROW })).toHaveCount(1)
    await expect(options.filter({ hasText: 'mock-ui-pack:m3-search-provider' })).toHaveCount(1)

    // action result: runs the fill's callback and closes the palette
    await options.filter({ hasText: 'Mock pack action' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-mock-search-action', 'ran')

    // keyboard: the provider rows come after every native row; ArrowDown to the first provider row
    await page.keyboard.press('Control+K')
    await searchInput(page).fill('mockpack')
    await expect(options.filter({ hasText: BILLING_ROW })).toHaveCount(1)
    const input = searchInput(page)
    const count = await options.count()
    const billingIndex = await options.evaluateAll(
      (nodes, text) => nodes.findIndex((node) => node.textContent?.includes(text)),
      BILLING_ROW
    )
    expect(billingIndex).toBeGreaterThanOrEqual(0)
    expect(billingIndex).toBeLessThan(count)
    for (let step = 0; step < billingIndex; step += 1) await input.press('ArrowDown')
    await expect(options.nth(billingIndex)).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')
    await expect(page).toHaveURL(/\/billing$/)
    await expect(page.getByTestId('mock-billing')).toBeVisible()
    expect(mismatches()).toEqual([])
  })

  test('denies: a failing or silent provider never breaks the palette and says so calmly', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'p72-18-fail')
    await open(page, '/settings', page.getByTestId(SEARCH))
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.keyboard.press('Control+K')
    const dialog = page.getByRole('dialog', { name: DIALOG })
    const input = searchInput(page)

    await input.fill('mockpack-fail')
    await expect(dialog.getByRole('status')).toHaveText('Some results could not be loaded.')
    await expect(dialog.getByRole('option').filter({ hasText: BILLING_ROW })).toHaveCount(0)

    await input.fill('mockpack-slow')
    await expect(dialog.getByRole('status')).toHaveText('Some results could not be loaded.', {
      timeout: 5000,
    })
    await expect(dialog).toBeVisible()
    await input.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((text) => !text.includes('Failed to load resource'))).toEqual([])
  })
})
