import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import { MembersPage } from '../pages/MembersPage.js'

// Story 69.4 AC-9.1: PV's own un-composed build still works for a real user on the three pages that
// gained region points (settings audit, settings notifications, project members). The send-test
// step of the notifications page needs an MFA-enrolled admin; the journey asserts the MFA hint
// instead (the send itself stays covered by notifications-settings-page*.test.ts), a recorded choice.
test.describe('J33 - the phase 5 pages behave as before the region points', () => {
  test('an owner searches the audit log, edits a notification preference and opens the members invite form', async ({
    page,
    context,
  }) => {
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j33'),
      password: ['e2e', 'J33', 'Phase5', 'Password', '123'].join('-'),
      orgName: uniqueOrgName('J33 Phase 5'),
    })

    // settings audit: a filtered search that matches nothing shows the summary and Clear filters
    await gotoHydrated(page, '/settings/audit', page.getByLabel('Event type'))
    await expect(page.getByRole('heading', { name: 'Audit & Compliance' })).toBeVisible()
    await page.getByLabel('Event type').fill('j33.nothing.matches')
    await page.locator('form[method="GET"]').getByRole('button', { name: 'Search' }).click()
    await expect(page).toHaveURL(/eventType=j33\.nothing\.matches/)
    await expect(page.getByText('No audit events match these filters.')).toBeVisible()
    await expect(page.getByText('event type = j33.nothing.matches')).toBeVisible()
    await page.getByRole('link', { name: 'Clear filters' }).click()
    await expect(page).toHaveURL(/\/settings\/audit$/)
    await expect(page.getByRole('heading', { name: 'Export' })).toBeVisible()

    // settings notifications: change a frequency and see it saved after a reload
    await gotoHydrated(
      page,
      '/settings/notifications',
      page.getByRole('heading', { name: 'Notification Preferences' })
    )
    const frequency = page.getByLabel(/^Frequency for /).first()
    await frequency.selectOption('digest_daily')
    const saved = page.waitForResponse(
      (response) => response.url().includes('updatePreference') && response.ok()
    )
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await saved
    await page.reload()
    await expect(page.getByLabel(/^Frequency for /).first()).toHaveValue('digest_daily')
    // an admin without MFA sees the hint instead of the send button
    await expect(page.getByRole('heading', { name: 'Send Test Notification' })).toBeVisible()
    await expect(page.getByText(/Enroll in MFA/)).toBeVisible()

    // project members: open the invite form, see the guidance text, cancel
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('J33'),
      slug: `j33-${Date.now().toString(36)}`,
    })
    const members = new MembersPage(page)
    await gotoHydrated(page, `/projects/${project.id}/members`, members.inviteMemberToggleButton())
    await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible()
    await expect(members.inviteMemberToggleButton()).toBeVisible()
    await members.inviteMemberToggleButton().click()
    await expect(page.locator('#invite-email-help')).toBeVisible()
    await expect(page.locator('#invite-role-help')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('#invite-email-help')).toHaveCount(0)
  })
})
