import { expect, test } from '@playwright/test'
import { trackHydrationMismatch } from './fixtures.js'

// Story 69.13 (69-6 AC-8, DW-559 item 1): the root error page. The pack overrides `+error.svelte`
// (M1) and renders PV's own `RootErrorHeader` and `RootErrorContent` with the `root.error.*` points,
// so the render-only fills on `root.error.header` and `root.error.content` are proven end to end in
// a product that replaced the page. The existing M1 error cases are untouched.
const ID = {
  header: 'mock-p13-error-header',
  content: 'mock-p13-error-content',
  mock: 'mock-error',
} as const
const SENTINEL = 'mock-ui-pack:m3-p13'

test.describe('M3 region points on the root error page', () => {
  test('works: a 404 shows the pack marker, PV markup and both fills in DOM order', async ({
    page,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const response = await page.goto('/mock-ui-pack-no-such-route')
    expect(response?.status()).toBe(404)
    await expect(page.getByTestId(ID.content)).toBeVisible()
    await expect(page.getByTestId(ID.mock)).toContainText('mock-ui-pack:m1-error')
    await expect(page.getByTestId(ID.header)).toContainText(`${SENTINEL}-root.error.header`)
    await expect(page.getByTestId(ID.content)).toContainText(`${SENTINEL}-root.error.content`)
    await expect(page.getByTestId(ID.content)).toHaveAttribute('data-status', '404')
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    const order = await page.evaluate((ids) => {
      const at = (id: string) => document.querySelector(`[data-testid="${id}"]`)
      const header = at(ids.header)
      const content = at(ids.content)
      const heading = document.querySelector('main h1')
      const follows = (a: Element | null, b: Element | null) =>
        a !== null &&
        b !== null &&
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      return {
        pvHeaderBeforeFill: follows(document.querySelector('header'), header),
        headerBeforeContent: follows(header, content),
        contentBeforeHeading: follows(content, heading),
      }
    }, ID)
    expect(order).toEqual({
      pvHeaderBeforeFill: true,
      headerBeforeContent: true,
      contentBeforeHeading: true,
    })
    expect(mismatches()).toEqual([])
  })

  test('fails: a 500 renders the same regions and leaks neither a stack nor the thrown message', async ({
    page,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const response = await page.goto('/boom')
    expect(response?.status()).toBe(500)
    await expect(page.getByTestId(ID.content)).toContainText(`${SENTINEL}-root.error.content`)
    await expect(page.getByTestId(ID.content)).toHaveAttribute('data-status', '500')
    await expect(page.getByTestId(ID.header)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible()
    const body = await page.content()
    expect(mismatches()).toEqual([])
    expect(body).not.toContain('boom-internal-detail')
    expect(body).not.toMatch(/\bat [A-Za-z_.<>]+ \(|node_modules|\.ts:\d+/)
  })
})
