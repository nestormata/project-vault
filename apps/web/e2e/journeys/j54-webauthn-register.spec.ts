import { expect, test } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'
import { SecurityPage } from '../pages/SecurityPage.js'

async function addVirtualAuthenticator(page: import('@playwright/test').Page) {
  const session = await page.context().newCDPSession(page)
  await session.send('WebAuthn.enable')
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

describeEachAppearance('J54 — register a hardware authenticator', (appearance) => {
  test('TOTP-enrolled owner registers, names, and removes a key; FR182 copy holds', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j54'),
      password: 'e2e-Owner-Password-123',
      orgName: uniqueOrgName('J54 Org'),
    })
    await enrollMfaViaApi(context)
    await addVirtualAuthenticator(page)

    const security = new SecurityPage(page)
    await security.goto()
    await expect(security.mfaEnabledHeading()).toBeVisible()
    await expect(security.hardwareKeysHeading()).toBeVisible()
    await expect(page.getByText(/cannot be copied, exported, or backed up/i)).toBeVisible()
    await expect(page.getByText(/use a recovery code from this page/i)).toBeVisible()
    await expectAppearanceApplied(page, appearance)
    await expectNoHorizontalOverflow(page)

    await security.hardwareKeyNameInput().fill('Desk key')
    await security.registerHardwareKeyButton().click()
    await expect(page.getByText('Desk key')).toBeVisible()

    const officeKey = 'Office key'
    await page.getByRole('button', { name: 'Rename' }).click()
    await page.getByLabel('Key name').first().fill(officeKey)
    await page.getByRole('button', { name: 'Save name' }).click()
    await expect(page.getByText(officeKey)).toBeVisible()

    await page.getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('button', { name: 'Confirm remove' }).click()
    await expect(page.getByText(officeKey)).toHaveCount(0)
    await expect(page.getByText(/no hardware keys are registered yet/i)).toBeVisible()
  })
})
