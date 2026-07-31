import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import {
  uniqueCredentialValue,
  uniqueEmail,
  uniqueOrgName,
  uniqueProjectName,
} from '../fixtures/ids.js'

const addDependentSystemLabel = 'Add dependent system'

test.describe('J10 — dependent-system inline validation', () => {
  test('rejects whitespace, localizes the error, and accepts a corrected retry', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j10-owner'),
      password: ['e2e', 'J10', 'Dependency', 'Password', '123'].join('-'),
      orgName: uniqueOrgName('J10 Inline Validation'),
    })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J10 Project'),
      slug: `j10-project-${Date.now()}`,
    })
    const credential = await createCredentialViaApi(context, project.id, {
      name: 'j10-credential',
      value: uniqueCredentialValue('j10-initial'),
    })

    await page.goto('/settings/language')
    const spanishOption = page.locator('li').filter({ hasText: 'Español' })
    await spanishOption.getByRole('button', { name: 'Select' }).click()
    await expect(spanishOption.getByRole('button', { name: 'Selected' })).toBeVisible()
    await page.goto(`/projects/${project.id}/credentials/${credential.id}`)
    const summary = page.locator('summary').filter({ hasText: addDependentSystemLabel })
    await summary.click()

    const nameInput = page.getByLabel('System name')
    await nameInput.fill('   ')
    await page.getByRole('button', { name: addDependentSystemLabel }).click()

    await expect(page.getByRole('alert')).toContainText('El nombre del sistema es obligatorio.')
    await expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    await expect(nameInput).toHaveAttribute(
      'aria-describedby',
      /dependency-system-name-help dependency-system-name-error/
    )
    await expect(summary.locator('..')).toHaveAttribute('open', '')

    await page.setViewportSize({ width: 375, height: 812 })
    await nameInput.fill('  j10-payment-worker  ')
    await page.getByRole('button', { name: addDependentSystemLabel }).click()

    await expect(page.getByText('j10-payment-worker (other)', { exact: true })).toBeVisible()
    await expect(page.getByText('El nombre del sistema es obligatorio.')).toHaveCount(0)
  })
})
