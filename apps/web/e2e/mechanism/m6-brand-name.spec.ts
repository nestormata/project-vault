import { expect, test } from '@playwright/test'
import { gotoHydrated } from '../fixtures/hydration.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { seedOrgOwner } from './fixtures.js'

// Story 72.16 AC-3 (CM request R1): the product name is the `brand_name` message, so a host renames
// PV everywhere by overlaying one key (the pack's `messages/en.json`). The mock pack overlays it and
// replaces no brand component; the composed browser shows the pack name in the auth page titles, in the
// tab titles and in the error page's fallback title, and none of PV's name is left in what a user
// reads or in the served HTML. (The shell's brand link and footer are the pack's own M5 and M4
// replacements, so the shell is proven by the unit tests and J46; these pages are PV's own.)

const PACK_BRAND = 'Mock Product'
const PV_BRAND = 'Project Vault'

describeEachAppearance('M6 message overlay: brand name', (appearance) => {
  test('works: the pack overlay of brand_name renames the auth pages and their titles', async ({
    page,
  }) => {
    const response = await page.request.get('/login')
    const html = await response.text()
    expect(html).toContain(`<title>${PACK_BRAND}</title>`)
    expect(html).not.toContain(PV_BRAND)

    await gotoHydrated(page, '/login', page.getByRole('heading', { name: 'Sign in' }))
    await expectAppearanceApplied(page, appearance)

    await expect(page).toHaveTitle(`Sign in | ${PACK_BRAND}`)
    expect(await page.locator('body').innerText()).not.toContain(PV_BRAND)
    await expectNoHorizontalOverflow(page)

    // a second auth page, whose title is a catalogue message that takes the {brand} parameter
    await gotoHydrated(page, '/register', page.getByRole('heading', { name: 'Register' }))
    await expect(page).toHaveTitle(`Register | ${PACK_BRAND}`)
    expect(await page.locator('body').innerText()).not.toContain(PV_BRAND)
  })

  test('works: a signed-in page title and a missing page use the pack name', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm6-brand')

    await gotoHydrated(page, '/settings', page.getByRole('heading', { name: 'Settings' }))
    await expectAppearanceApplied(page, appearance)
    await expect(page).toHaveTitle(`Settings | ${PACK_BRAND}`)
    expect(await page.locator('body').innerText()).not.toContain(PV_BRAND)

    // the pack's own error page: its title and the served HTML carry the pack name only
    const missing = await page.request.get('/m6-brand-name-does-not-exist')
    expect(missing.status()).toBe(404)
    const html = await missing.text()
    expect(html).toContain(`Page not found | ${PACK_BRAND}`)
    expect(html).not.toContain(PV_BRAND)
    await expectNoHorizontalOverflow(page)
  })
})
