import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const FIELD_1_VALUE = 'Field 1 value'
const FIELD_2_VALUE = 'Field 2 value'
const USERNAME_VALUE = 'svc-account'
const PASSWORD_VALUE = 'initial-password'

// J6 (Story 13.3): open a Login-template secret and confirm the non-sensitive `username` field is
// visible immediately (no reveal click, AC-1/AC-2), while `password` stays masked until its own
// "Reveal" button is clicked (AC-3/AC-4) — the persona journey (Morgan-member) from this story's
// Product Surface Contract, exercised end to end through the real UI.

test.describe('J6 — per-field visibility and reveal', () => {
  test('AC-1/AC-2/AC-3/AC-4: username is visible on load; password requires its own Reveal click', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j6-owner')
    const password = OWNER_PASSWORD
    const orgName = uniqueOrgName('J6 Org')

    await registerAndLoginViaApi(context, { email, password, orgName })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J6 Project'),
      slug: `j6-${Date.now()}`,
    })
    const projectId = project.id

    await page.goto(`/projects/${projectId}/credentials/new`)
    await page.getByLabel('Name', { exact: true }).fill('j6-db-login')
    await page.getByLabel('Template', { exact: true }).selectOption('login')
    await page.getByLabel(FIELD_1_VALUE).fill(USERNAME_VALUE)
    await page.getByLabel(FIELD_2_VALUE).fill(PASSWORD_VALUE)
    await page.getByRole('button', { name: 'Create credential' }).click()
    await page.waitForURL(`**/projects/${projectId}/credentials/*`)

    // AC-1/AC-2: username's value is visible immediately, no reveal click required.
    const usernameRow = page.getByTestId('field-row-username')
    await expect(usernameRow).toContainText(USERNAME_VALUE)
    await expect(usernameRow.getByRole('button', { name: 'Reveal' })).toHaveCount(0)

    // AC-3: password starts masked with its own Reveal button; not fetched yet.
    const passwordRow = page.getByTestId('field-row-password')
    await expect(passwordRow).not.toContainText(PASSWORD_VALUE)
    await expect(page.getByTestId('field-masked-password')).toBeVisible()

    // AC-4: revealing password does not disturb the already-visible username value.
    await passwordRow.getByRole('button', { name: 'Reveal' }).click()
    await expect(passwordRow).toContainText(PASSWORD_VALUE)
    await expect(usernameRow).toContainText(USERNAME_VALUE)

    // Subtask 3.4: Hide clears only the password row.
    await passwordRow.getByRole('button', { name: 'Hide' }).click()
    await expect(passwordRow).not.toContainText(PASSWORD_VALUE)
    await expect(usernameRow).toContainText(USERNAME_VALUE)
  })
})
