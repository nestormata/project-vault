import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'
import { RegisterPage } from '../pages/RegisterPage.js'
import { SecurityPage } from '../pages/SecurityPage.js'

// Story 69.6 AC-9: PV's own un-composed build still works for a real user on the regions the phase 6
// work wrapped: the signed-in layout (global search), a pre-auth page (the registration form, with its
// back link to sign in), a back link and a stateful form region (the MFA enrollment panel). Every
// assertion is something the page did before the wrapper components existed.
test.describe('J34 - the phase 6 regions behave as before the wrapper components', () => {
  test('a visitor reaches the registration form, then an owner searches, walks a back link and starts MFA enrollment', async ({
    page,
    context,
  }) => {
    // pre-auth page: the registration form (RegisterFormRegion) takes input and validates it
    const register = new RegisterPage(page)
    await register.goto()
    await expect(register.submitButton()).toBeVisible()
    await register.emailInput().fill('not-an-email')
    await register.passwordInput().fill('short')
    await register.submitButton().click()
    await expect(page).toHaveURL(/\/register/)
    await expect(register.emailInput()).toHaveValue('not-an-email')

    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j34'),
      password: ['e2e', 'J34', 'Phase6', 'Password', '123'].join('-'),
      orgName: uniqueOrgName('J34 Phase 6'),
    })

    // signed-in layout: the global search region opens with the shortcut and closes with Escape
    await gotoHydrated(
      page,
      '/settings',
      page.getByRole('heading', { name: 'Settings', exact: true })
    )
    await page.keyboard.press('Control+K')
    await expect(page.getByRole('dialog', { name: 'Global search' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Global search' })).toHaveCount(0)

    // a back link region: the language page links back to Settings and the click navigates
    const back = page.getByRole('link', { name: '← Settings' })
    await gotoHydrated(page, '/settings/language', back)
    await back.click()
    await expect(page).toHaveURL(/\/settings$/)

    // a stateful form region: the MFA enrollment panel starts enrollment and reveals the secret
    const security = new SecurityPage(page)
    await gotoHydrated(page, '/settings/security', security.startEnrollmentButton())
    await security.startEnrollmentButton().click()
    await expect(security.secretText()).toBeVisible()
    await expect(security.totpInput()).toBeVisible()
  })
})
