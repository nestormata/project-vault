import { expect, test, type Page } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

async function expectVisibleFormGuidance(page: Page): Promise<void> {
  const controls = page.locator('input:not([type="hidden"]), select, textarea')
  const count = await controls.count()
  expect(count).toBeGreaterThan(0)

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index)
    if (!(await control.isVisible())) continue
    const describedBy = await control.getAttribute('aria-describedby')
    expect(describedBy, `control ${index} is missing aria-describedby`).toBeTruthy()

    for (const id of describedBy?.split(/\s+/).filter(Boolean) ?? []) {
      const description = page.locator(`[id="${id}"]`)
      await expect(description, `missing visible description #${id}`).toBeVisible()
      await expect(description).not.toHaveText('')
    }
  }
}

test.describe('J9 — contextual guidance for every form control', () => {
  test('pre-auth registration keeps values and localizes visible explanations on a narrow viewport', async ({
    page,
  }) => {
    const password = ['e2e', 'J9', 'Guidance', 'Password', '123'].join('-')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/register')

    await page.getByLabel('Email').fill(uniqueEmail('j9-register'))
    await page.getByLabel('Organization name').fill(uniqueOrgName('J9 Guidance'))
    await page.getByLabel('Password').fill(password)
    await expectVisibleFormGuidance(page)

    await page.getByRole('button', { name: 'Español' }).click()
    await expect(
      page
        .getByText('Ingresa el valor que usa esta configuración. Revísalo antes de guardar.')
        .first()
    ).toBeVisible()
    await expectVisibleFormGuidance(page)
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(/j9-register/)
    await expect(page.getByLabel('Nombre de la organización')).toHaveValue(/J9 Guidance/)
    await expect(page.getByLabel('Contraseña')).toHaveValue(password)
  })

  test('authenticated project creation exposes guidance and preserves normal submission', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j9-project'),
      password: ['e2e', 'J9', 'Project', 'Password', '123'].join('-'),
      orgName: uniqueOrgName('J9 Project'),
    })
    await page.goto('/projects/new')
    await expectVisibleFormGuidance(page)

    const suffix = Date.now().toString()
    await page.getByLabel('Name', { exact: true }).fill(`J9 project ${suffix}`)
    await page.getByLabel('Slug', { exact: true }).fill(`j9-project-${suffix.slice(-8)}`)
    await page.getByLabel('Description', { exact: true }).fill('Guidance journey project')
    await page.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
  })
})
