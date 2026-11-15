import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
  type Appearance,
} from '../fixtures/appearance.js'
import {
  completeGuestCodeStep,
  createdExternalShareLinkFromPage,
  openGuestShare,
  tokenFromShareUrl,
} from '../fixtures/guest-verification.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const SECRET_VALUE = 'j52-legacy-share-secret'
const GUARD_COPY = /every field on this secret is sensitive/i

describeEachAppearance('J52 legacy single-value external share field selection', (appearance) => {
  test(`checking value creates a share whose guest reveal is the secret [${appearance.name}]`, async ({
    page,
    context,
    browser,
  }) => {
    test.slow()
    const credentialName = `j52-secret-${randomUUID().slice(0, 8)}`
    await registerAndLoginViaApi(context, {
      email: uniqueEmail(`j52-${appearance.name.replace(/\s+/g, '-')}`),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J52 Org'),
    })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J52 Project'),
      slug: `j52-${randomUUID().slice(0, 12)}`,
    })
    const credential = await createCredentialViaApi(context, project.id, {
      name: credentialName,
      value: SECRET_VALUE,
    })

    await gotoHydrated(
      page,
      `/projects/${project.id}/credentials/${credential.id}`,
      page.getByRole('button', { name: 'External (email)' })
    )
    await expectAppearanceApplied(page, appearance)
    await expectNoHorizontalOverflow(page)

    const valueCheckbox = page.getByRole('checkbox', { name: /value/i })
    await expect(valueCheckbox).toBeVisible()
    await expect(valueCheckbox).not.toBeChecked()

    await page.getByRole('button', { name: 'External (email)' }).click()
    await page.getByPlaceholder('vendor@invalid').fill(uniqueEmail('j52-blocked'))
    await page.getByLabel('Confirm your password').fill(OWNER_PASSWORD)
    await page.getByRole('button', { name: 'Create share link' }).click()
    await expect(page.getByText(GUARD_COPY)).toBeVisible()

    await valueCheckbox.check()
    const recipientEmail = uniqueEmail('j52-guest')
    await page.getByPlaceholder('vendor@invalid').fill(recipientEmail)
    await page.getByLabel('Confirm your password').fill(OWNER_PASSWORD)
    await page.getByRole('button', { name: 'Create share link' }).click()
    const token = tokenFromShareUrl(await createdExternalShareLinkFromPage(page))

    const guestContext = await newGuest(browser, appearance)
    const guest = await guestContext.newPage()
    await openGuestShare(guest, token)
    await completeGuestCodeStep(guest, { recipientEmail, rawToken: token })
    await guest.getByRole('button', { name: 'Reveal secret' }).click()
    await expect(guest.getByText(SECRET_VALUE, { exact: true })).toBeVisible()
    await expect(guest.getByText('[]', { exact: true })).toHaveCount(0)
    await expectAppearanceApplied(guest, appearance)
    await expectNoHorizontalOverflow(guest)
    await guestContext.close()
  })
})

async function newGuest(browser: Browser, appearance: Appearance): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { ...appearance.viewport },
    colorScheme: appearance.colorScheme,
  })
}
