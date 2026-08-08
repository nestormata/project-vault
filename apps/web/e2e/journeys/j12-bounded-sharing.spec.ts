import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const USERNAME_VALUE = 'j12-svc-account'
const PASSWORD_VALUE = 'j12-super-secret-password'

// J12 (Story 20.5): the Scoped/Bounded Sharing Contract's UI surface (AC-9), end to end through
// the real create-share form and the real (unauthenticated) external-recipient reveal page —
// mirrors the story's own "Live-verify via make docker-up + Chrome/Playwright" task. Uses the
// external-recipient share form (no second org member needed): create a Login-template
// credential, create a default (attributeKeys omitted) external share, confirm the recipient
// sees only the non-sensitive field, then create a second share explicitly naming the sensitive
// field and confirm the recipient sees it too.

test.describe('J12 — bounded/scoped credential sharing', () => {
  test('AC-2/AC-9: default share excludes the sensitive field; naming it explicitly includes it', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j12-owner')
    const orgName = uniqueOrgName('J12 Org')
    await registerAndLoginViaApi(context, { email, password: OWNER_PASSWORD, orgName })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J12 Project'),
      slug: `j12-${Date.now()}`,
    })
    const projectId = project.id

    await page.goto(`/projects/${projectId}/credentials/new`)
    await page.getByLabel('Name', { exact: true }).fill('j12-login')
    await page.getByLabel('Template', { exact: true }).selectOption('login')
    await page.getByLabel('Field 1 value').fill(USERNAME_VALUE)
    await page.getByLabel('Field 2 value').fill(PASSWORD_VALUE)
    await page.getByRole('button', { name: 'Create credential' }).click()
    await page.waitForURL(`**/projects/${projectId}/credentials/*`)

    // --- Share #1: default selection (attributeKeys omitted — sensitivity-default-exclusion) ---
    await page.getByRole('button', { name: 'External (email)' }).click()
    await expect(page.getByText('Sensitive — excluded by default')).toBeVisible()
    // AC-9: the sensitive `password` field's checkbox renders unchecked by default; `username`'s
    // renders checked — visible confirmation before submit, not just inferred from the badge.
    //
    // Bugfix (dev-auto review): scoped to the "Fields to share" fieldset by its accessible name
    // (the `<legend>`) — an unscoped `label, { hasText: 'password' }` also substring-matches the
    // later "Confirm your password" step-up label, and only happened to pass because the fields
    // fieldset currently renders first in the form.
    const fieldsFieldset = page.getByRole('group', { name: 'Fields to share' })
    const usernameRow = fieldsFieldset.locator('label', { hasText: 'username' })
    const passwordRow = fieldsFieldset.locator('label', { hasText: 'password' }).first()
    await expect(usernameRow.getByRole('checkbox')).toBeChecked()
    await expect(passwordRow.getByRole('checkbox')).not.toBeChecked()

    await page.getByLabel('Recipient email').fill('j12-recipient@example.com')
    await page.getByLabel('Confirm your password').fill(OWNER_PASSWORD)
    await page.getByRole('button', { name: 'Create share link' }).click()

    await expect(page.getByText('Share link created')).toBeVisible()
    const defaultShareCode = await page
      .locator('code', { hasText: '/external-shares/' })
      .textContent()
    expect(defaultShareCode).toBeTruthy()
    const defaultToken = new URL(defaultShareCode as string).pathname.split('/').pop() as string

    // --- Share #2: explicitly opt the sensitive `password` field in ---
    await passwordRow.getByRole('checkbox').click()
    await expect(passwordRow.getByRole('checkbox')).toBeChecked()
    await page.getByLabel('Recipient email').fill('j12-recipient-2@example.com')
    await page.getByLabel('Confirm your password').fill(OWNER_PASSWORD)
    await page.getByRole('button', { name: 'Create share link' }).click()
    await expect(page.getByText('Share link created')).toBeVisible()
    const explicitShareCode = await page
      .locator('code', { hasText: '/external-shares/' })
      .textContent()
    const explicitToken = new URL(explicitShareCode as string).pathname.split('/').pop() as string

    // --- Recipient side: default share reveals only the non-sensitive field ---
    const recipientContext = await context.browser()?.newContext()
    if (!recipientContext) throw new Error('unreachable — browser() only null after browser close')
    const recipientPage = await recipientContext.newPage()
    await recipientPage.goto(`/external-shares/${defaultToken}`)
    await recipientPage.getByRole('button', { name: 'Reveal' }).click()
    await expect(recipientPage.getByText('username', { exact: true })).toBeVisible()
    await expect(recipientPage.getByText(USERNAME_VALUE, { exact: true })).toBeVisible()
    await expect(recipientPage.getByText('password', { exact: true })).toHaveCount(0)
    await expect(recipientPage.locator('code')).toHaveCount(1)

    // --- Recipient side: explicit share reveals the named sensitive field too ---
    const recipientPage2 = await recipientContext.newPage()
    await recipientPage2.goto(`/external-shares/${explicitToken}`)
    await recipientPage2.getByRole('button', { name: 'Reveal' }).click()
    await expect(recipientPage2.getByText('username', { exact: true })).toBeVisible()
    await expect(recipientPage2.getByText(USERNAME_VALUE, { exact: true })).toBeVisible()
    await expect(recipientPage2.getByText('password', { exact: true })).toBeVisible()
    await expect(recipientPage2.getByText(PASSWORD_VALUE, { exact: true })).toBeVisible()
    await expect(recipientPage2.locator('code')).toHaveCount(2)

    await recipientContext.close()
  })
})
