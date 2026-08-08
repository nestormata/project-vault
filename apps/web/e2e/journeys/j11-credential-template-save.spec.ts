import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'

// J11 (credential template validation): every template uses the same authenticated create path;
// Custom specifically proves that a multi-field field set is submitted as structured data rather
// than being misinterpreted as a single legacy value.
test.describe('J11 — credential template saves', () => {
  test('Custom saves multiple fields successfully through the Chrome UI', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j11-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J11 Templates'),
    })

    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J11 Project'),
      slug: `j11-${Date.now()}`,
    })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    await page.goto(`/projects/${project.id}/credentials/new`)
    await page.getByLabel('Name', { exact: true }).fill('j11-custom')
    await page.getByLabel('Template', { exact: true }).selectOption('custom')
    await page.getByRole('button', { name: /add field/i }).click()
    await page.getByRole('button', { name: /add field/i }).click()
    await page.getByLabel('Field 1 name', { exact: true }).fill('access-token')
    await page.getByLabel('Field 1 value', { exact: true }).fill('token')
    await page.getByLabel('Field 2 name', { exact: true }).fill('region')
    await page.getByLabel('Field 2 value', { exact: true }).fill('us-east-1')
    await page.getByRole('button', { name: 'Create credential' }).click()
    await page.waitForURL((url) => {
      const pathname = typeof url === 'string' ? new URL(url).pathname : url.pathname
      return (
        pathname.startsWith(`/projects/${project.id}/credentials/`) && !pathname.endsWith('/new')
      )
    })
    await expect(page.getByText('Access token is missing')).toHaveCount(0)
    await expect(page.getByTestId('field-value-access-token')).toHaveText('token')
    await expect(page.getByTestId('field-value-region')).toHaveText('us-east-1')
  })
})
