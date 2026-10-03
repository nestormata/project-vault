import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { trackHydrationMismatch } from './fixtures.js'

// Story 68.10 AC-1 / AC-5, M6 (theme): PV's token contract is the shared surface, CM's own styles are
// not limited by it. Computed styles in a real browser, never source greps. Custom properties are
// polled: the stylesheet is a render-blocking link, but the spec must not depend on that ordering.

/** The computed value of a custom property on <html>, normalised (the CSS minifier writes `.75rem`
 * for `0.75rem`, and a hex colour in any case). */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name
  )
}

test.describe('M6 theme', () => {
  test('works: PV tokens carry the pack values and a pack component uses a PV token and its own styles', async ({
    page,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await page.goto('/billing')
    await expect
      .poll(async () => (await token(page, '--color-primary-600')).toLowerCase())
      .toBe('#0f766e')
    // the radius token: the minifier may write `.75rem` for `0.75rem`
    await expect.poll(async () => Number.parseFloat(await token(page, '--radius-md'))).toBe(0.75)
    // a pack element that reads the PV colour token through var()
    await expect(page.getByTestId('mock-billing-token')).toHaveCSS('color', 'rgb(15, 118, 110)')
    // the font token reaches the pack through PV's own Tailwind utility (`font-body`)
    const heading = page.getByTestId('mock-billing')
    await expect(heading).toHaveCSS('font-weight', '500')
    // the pack's own non-token style and a utility class used only by the pack both apply
    await expect(heading).toHaveCSS('border-top-style', 'dashed')
    await expect(heading).toHaveCSS('background-color', 'rgb(107, 68, 35)')
    // the client did not rebuild the head: the stylesheet is still there after hydration
    expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0)
    expect(mismatches()).toEqual([])
  })

  test('fails: a token PV does not define is carried through without an error', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const response = await page.goto('/billing')
    expect(response?.status()).toBe(200)
    await expect.poll(() => token(page, '--mock-ui-pack-unknown-token')).toBe('7px')
    expect(errors).toEqual([])
  })
})
