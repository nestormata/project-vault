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
const BRAND = 'Project Vault'

// J46 (Story 72.16, CM request R1): the product name is the `brand_name` message. Without a host
// overlay every place that names the product renders exactly what PV rendered before the key
// existed: the auth page header and tab title, and the signed-in shell's brand link, tab title and
// footer. The overlay case runs in the composed mechanism suite (`mechanism/m6-brand-name.spec.ts`).

describeEachAppearance('J46 brand name', (appearance) => {
  test('AC1: the sign-in page names the product in its header and its tab title', async ({
    page,
  }) => {
    await gotoHydrated(page, '/login', page.getByRole('heading', { name: 'Sign in' }))
    await expectAppearanceApplied(page, appearance)

    await expect(page).toHaveTitle(`Sign in | ${BRAND}`)
    await expect(page.getByText(BRAND, { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('AC1: the signed-in shell names the product in the brand link, the tab title and the footer', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j46-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J46 Org'),
    })

    await gotoHydrated(page, '/dashboard', page.getByRole('heading', { name: 'Secret overview' }))
    await expectAppearanceApplied(page, appearance)

    await expect(page).toHaveTitle(`Dashboard | ${BRAND}`)
    await expect(page.locator('header').getByRole('link', { name: BRAND })).toBeVisible()
    await expect(
      page.locator('footer').getByText(`${new Date().getFullYear()} ${BRAND}`)
    ).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})
