import { expect, test } from '@playwright/test'
import { gotoHydrated } from '../fixtures/hydration.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { seedOrgOwner } from './fixtures.js'

// Story 72.17 AC-2 (CM request R2): the shell's tagline is the `shell_brand_tagline` message, so a
// host changes it by overlaying one key (the pack's `messages/en.json`), with no `ShellBrand`
// replacement. The mock pack overlays the key and replaces no brand component; the composed
// browser shows the pack text and none of PV's default.

const PACK_TAGLINE = 'mock-ui-pack:m6-tagline'
const PV_DEFAULT_TAGLINE = 'Run complex projects. Miss nothing.'

describeEachAppearance('M6 message overlay: shell tagline', (appearance) => {
  test('works: the pack overlay of shell_brand_tagline replaces the default tagline', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm6-tagline')

    await gotoHydrated(page, '/dashboard', page.getByText(PACK_TAGLINE, { exact: true }))
    await expectAppearanceApplied(page, appearance)

    await expect(page.getByText(PACK_TAGLINE, { exact: true })).toBeVisible()
    await expect(page.getByText(PV_DEFAULT_TAGLINE)).toHaveCount(0)
    // the brand name still comes from the `shell.brand` nav data (the pack's M5 delta renames it),
    // untouched by the message overlay
    await expect(page.locator('header').getByRole('link', { name: 'Mock Brand' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })
})
