import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const FIELD_1_VALUE = 'Field 1 value'
const FIELD_2_VALUE = 'Field 2 value'

// J5 (Story 13.2): create a multi-field secret from the Login template, view it on the detail
// page, then edit it to add a `notes` field and save — the persona journey (Morgan-member) from
// the story's Product Surface Contract, exercised end to end through the real UI.

test.describe('J5 — multi-field secret via templates', () => {
  test('AC-1/AC-3/AC-4: create a Login-template secret, then edit-add a field and save', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j5-owner')
    const password = OWNER_PASSWORD
    const orgName = uniqueOrgName('J5 Org')

    await registerAndLoginViaApi(context, { email, password, orgName })
    // Skip the first-run onboarding dialog so it doesn't block /(app) navigation.
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })

    const projectRes = await context.request.post('/api/v1/projects', {
      data: { name: uniqueProjectName('J5 Project'), slug: `j5-${Date.now()}` },
    })
    expect(projectRes.ok()).toBeTruthy()
    const projectId = (await projectRes.json()).data.id as string

    // --- Create from the Login template ---
    await page.goto(`/projects/${projectId}/credentials/new`)
    await page.getByLabel('Name', { exact: true }).fill('j5-db-login')
    await page.getByLabel('Template', { exact: true }).selectOption('login')

    // Template pre-populates username + password (AC-1).
    await expect(page.getByLabel('Field 1 name')).toHaveValue('username')
    await expect(page.getByLabel('Field 2 name')).toHaveValue('password')
    await page.getByLabel(FIELD_1_VALUE).fill('svc-account')
    await page.getByLabel(FIELD_2_VALUE).fill('initial-password')
    await page.getByRole('button', { name: 'Create credential' }).click()

    // Lands on the detail page, which iterates the field list.
    await page.waitForURL(`**/projects/${projectId}/credentials/*`)
    const fieldList = page.getByTestId('field-list')
    await expect(fieldList).toContainText('username')
    await expect(fieldList).toContainText('password')

    // --- Edit: add a notes field and save (AC-3 add + AC-4 whole-field-set version) ---
    await page.getByRole('button', { name: 'Edit fields' }).click()
    // Existing sensitive values are pre-filled so unchanged fields round-trip (AC-4). Editing is a
    // blind overwrite — no reveal-first gate (AC-8).
    await expect(page.getByLabel(FIELD_1_VALUE)).toHaveValue('svc-account')
    await page.getByRole('button', { name: '+ Add field' }).click()
    const newIndex = await page.getByLabel(/Field \d+ name/).count()
    await page.getByLabel(`Field ${newIndex} name`).fill('notes')
    await page.getByLabel(`Field ${newIndex} value`).fill('rotate quarterly')
    await page.getByRole('button', { name: 'Save fields' }).click()

    // The detail field list now includes notes.
    await expect(page.getByTestId('field-list')).toContainText('notes')
  })

  test('AC-3: renaming a field to a colliding key shows an inline error and does not save', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j5-collision')
    const password = OWNER_PASSWORD
    await registerAndLoginViaApi(context, { email, password, orgName: uniqueOrgName('J5 Coll') })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
    const projectRes = await context.request.post('/api/v1/projects', {
      data: { name: uniqueProjectName('J5 Coll Project'), slug: `j5c-${Date.now()}` },
    })
    const projectId = (await projectRes.json()).data.id as string

    await page.goto(`/projects/${projectId}/credentials/new`)
    await page.getByLabel('Name', { exact: true }).fill('j5-collision')
    await page.getByLabel('Template', { exact: true }).selectOption('login')
    await page.getByLabel(FIELD_1_VALUE).fill('u')
    await page.getByLabel(FIELD_2_VALUE).fill('p')
    // Rename password -> username (case-insensitive collision) client-side before submit.
    await page.getByLabel('Field 2 name').fill('Username')
    await page.getByRole('button', { name: 'Create credential' }).click()

    // The client duplicate-key affordance blocks the save with an inline error on the colliding row.
    await expect(page.getByText(/duplicate field name/i)).toBeVisible()
  })
})
