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
const DEFAULT_TAGLINE = 'Run complex projects. Miss nothing.'

// J45 (Story 72.17, CM request R2): the shell header's tagline is the `shell_brand_tagline` message.
// Without a host overlay the default text is exactly what PV rendered before the key existed, in
// the brand block next to the product name, at every appearance. The overlay case runs in the
// composed mechanism suite (`mechanism/m6-message-overlay.spec.ts`), where a pack can overlay it.

describeEachAppearance('J45 shell brand tagline', (appearance) => {
  test('AC1: the default tagline shows under the product name and the page does not overflow', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j45-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J45 Org'),
    })

    await gotoHydrated(page, '/dashboard', page.getByRole('heading', { name: 'Secret overview' }))
    await expectAppearanceApplied(page, appearance)

    const tagline = page.getByText(DEFAULT_TAGLINE, { exact: true })
    await expect(tagline).toHaveCount(1)
    await expect(tagline).toBeVisible()
    // the brand block is name link + tagline in one container: the tagline sits right under the name
    const brand = page.locator('header').getByRole('link', { name: 'Project Vault' })
    await expect(brand).toBeVisible()
    const nameBox = await brand.boundingBox()
    const taglineBox = await tagline.boundingBox()
    if (nameBox === null || taglineBox === null) throw new Error('brand block is not laid out')
    expect(taglineBox.y).toBeGreaterThan(nameBox.y)
    await expectNoHorizontalOverflow(page)
  })
})
