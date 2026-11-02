import { expect, test, type Page } from '@playwright/test'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
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
const QUERY = 'mockpack'
const FAIL_QUERY = 'mockpack-fail'
const SLOW_QUERY = 'mockpack-slow'
const FAILURE_NOTICE = 'Some results could not be loaded.'
const SELECTED = 'aria-selected'
const SEARCH_QUERY_ATTR = 'data-mock-search-query'

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
    await searchInput(page).fill(QUERY)

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
    await searchInput(page).fill(QUERY)
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
    await expect(options.nth(billingIndex)).toHaveAttribute(SELECTED, 'true')
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

    await input.fill(FAIL_QUERY)
    await expect(dialog.getByRole('status')).toHaveText(FAILURE_NOTICE)
    await expect(dialog.getByRole('option').filter({ hasText: BILLING_ROW })).toHaveCount(0)

    await input.fill(SLOW_QUERY)
    await expect(dialog.getByRole('status')).toHaveText(FAILURE_NOTICE, {
      timeout: 5000,
    })
    await expect(dialog).toBeVisible()
    await input.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((text) => !text.includes('Failed to load resource'))).toEqual([])
  })
})

// The previous provider row stays after a new search has started (the provider was asked the new
// query) and only leaves when that answer arrives. `mockpack-slow` never answers, so the row from
// `mockpack` is still there once `data-mock-search-query` shows the new query. No clock assertion.
describeEachAppearance('provider rows stay until the new answer', (appearance) => {
  test(`the arrowed row remains after the next search starts [${appearance.name}]`, async ({
    page,
    context,
  }) => {
    const slug = appearance.name.replace(/\s+/g, '-')
    await seedOrgOwner(context, `p72-26-${slug}`)
    await open(page, '/settings', page.getByTestId(SEARCH))
    await expectAppearanceApplied(page, appearance)

    await page.keyboard.press('Control+K')
    const dialog = page.getByRole('dialog', { name: DIALOG })
    const input = searchInput(page)
    await input.fill(QUERY)
    const billing = dialog.getByRole('option').filter({ hasText: BILLING_ROW })
    await expect(billing).toHaveCount(1)
    const billingIndex = await dialog
      .getByRole('option')
      .evaluateAll(
        (nodes, text) => nodes.findIndex((node) => node.textContent?.includes(text)),
        BILLING_ROW
      )
    for (let step = 0; step < billingIndex; step += 1) await input.press('ArrowDown')
    await expect(billing).toHaveAttribute(SELECTED, 'true')

    await input.fill(SLOW_QUERY)
    await expect(page.locator('html')).toHaveAttribute(SEARCH_QUERY_ATTR, SLOW_QUERY)
    await expect(billing).toHaveCount(1)
    await expect(billing).toHaveAttribute(SELECTED, 'true')
    await expect(dialog.getByText(FAILURE_NOTICE)).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })
})
