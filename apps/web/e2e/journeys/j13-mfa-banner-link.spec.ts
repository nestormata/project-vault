import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

test.describe('J13 — MFA banner navigation', () => {
  test('renders the MFA enrollment destination as a direct link', async ({ page, context }) => {
    const email = uniqueEmail('j13-owner')
    const credentials = {
      email,
      password: ['e2e', 'J13', 'Mfa', 'Link', '123'].join('-'),
      orgName: uniqueOrgName('J13 MFA Org'),
    }
    await registerAndLoginViaApi(context, {
      ...credentials,
    })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    await page.goto('/dashboard')
    const securityLink = page.getByRole('link', { name: /settings\/security/i })
    await expect(securityLink).toBeVisible()
    await expect(securityLink).toHaveAttribute('href', '/settings/security')
  })
})
