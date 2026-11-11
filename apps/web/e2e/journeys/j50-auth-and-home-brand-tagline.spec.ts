import { expect, test } from '@playwright/test'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { gotoHydrated } from '../fixtures/hydration.js'

const DEFAULT_TAGLINE = 'Run complex projects. Miss nothing.'

// J50 (Story 72.23): auth pages and the public home read `shell_brand_tagline`. Without a host
// overlay the default text is exactly what those pages rendered before they called the message.
// The overlay case runs in the composed mechanism suite (`mechanism/m6-message-overlay.spec.ts`).

describeEachAppearance('J50 auth and public home brand tagline', (appearance) => {
  test('AC1: the sign-in page shows the default tagline and does not overflow', async ({
    page,
  }) => {
    await gotoHydrated(page, '/login', page.getByRole('heading', { name: 'Sign in' }))
    await expectAppearanceApplied(page, appearance)

    await expect(page.getByText(DEFAULT_TAGLINE, { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('AC1: the register page shows the default tagline and does not overflow', async ({
    page,
  }) => {
    await gotoHydrated(page, '/register', page.getByRole('heading', { name: 'Register' }))
    await expectAppearanceApplied(page, appearance)

    await expect(page.getByText(DEFAULT_TAGLINE, { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('AC1: the public home shows the default tagline and does not overflow', async ({ page }) => {
    await gotoHydrated(page, '/', page.getByRole('heading', { name: 'Project Vault' }))
    await expectAppearanceApplied(page, appearance)

    await expect(page.getByText(DEFAULT_TAGLINE, { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})
