import { expect, test } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  createInvitationViaApi,
  createProjectViaApi,
  createServiceEndpointViaApi,
} from '../fixtures/api.js'
import {
  extractTokenFromAcceptUrl,
  readLatestInvitationAcceptUrl,
  setOrganizationRoleViaDb,
} from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import { InvitationAcceptPage } from '../pages/InvitationAcceptPage.js'
import { LoginPage } from '../pages/LoginPage.js'
import { RegisterPage } from '../pages/RegisterPage.js'

const MONITORING_ACTIVE = 'Monitoring active'

test.describe('Epic 20.3 — paused monitoring controls', () => {
  test('owner can navigate list → detail → pause → resume', async ({ page, context }) => {
    const ownerPassword = ['e2e', 'Epic20', 'Owner', 'Password', '123'].join('-')
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('epic20-owner'),
      password: ownerPassword,
      orgName: uniqueOrgName('Epic 20 Monitoring Org'),
    })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('Epic 20 Monitoring Project'),
      slug: `epic20-monitoring-${Date.now()}`,
    })
    const endpoint = await createServiceEndpointViaApi(context, project.id, {
      name: 'Epic 20 canary',
      url: 'https://example.com/health',
    })

    await page.goto(`/projects/${project.id}/service-endpoints`)
    await expect(page.getByText('Epic 20 canary')).toBeVisible()
    // Story 18.13: list rows render the compact pause variant, which carries the state as text
    // rather than a per-row heading. The detail-page heading assertions below are unchanged.
    await expect(page.getByText(MONITORING_ACTIVE)).toBeVisible()
    // ...and it must NOT be a heading here — a heading would mean the detail-page card variant
    // leaked back into a table row, which is exactly what this story removed.
    await expect(page.getByRole('heading', { name: MONITORING_ACTIVE })).toHaveCount(0)
    await page.getByRole('link', { name: 'Edit' }).click()
    await expect(page).toHaveURL((url) =>
      url.pathname.endsWith(`/projects/${project.id}/service-endpoints/${endpoint.id}`)
    )

    await page.getByRole('button', { name: 'Pause monitoring' }).click()
    await expect(page.getByRole('dialog')).toContainText('Future probes')
    await page.getByRole('dialog').getByRole('button', { name: 'Pause monitoring' }).click()
    await expect(page.getByRole('heading', { name: 'Monitoring paused' })).toBeVisible()
    await expect(page.getByText(/last known status/i)).toBeVisible()

    await page.getByRole('button', { name: 'Resume monitoring' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Resume monitoring' }).click()
    await expect(page.getByRole('heading', { name: MONITORING_ACTIVE })).toBeVisible()
  })

  test('viewer sees paused state and no mutation control', async ({ browser }) => {
    const ownerContext = await browser.newContext()
    const ownerEmail = uniqueEmail('epic20-viewer-owner')
    const ownerPassword = ['e2e', 'Epic20', 'Viewer', 'Owner', 'Password', '123'].join('-')
    const viewerPassword = ['e2e', 'Epic20', 'Viewer', 'Password', '123'].join('-')
    const owner = await registerAndLoginViaApi(ownerContext, {
      email: ownerEmail,
      password: ownerPassword,
      orgName: uniqueOrgName('Epic 20 Viewer Org'),
    })
    const project = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('Epic 20 Viewer Project'),
      slug: `epic20-viewer-${Date.now()}`,
    })
    const endpoint = await createServiceEndpointViaApi(ownerContext, project.id, {
      name: 'Paused viewer canary',
      url: 'https://example.com/paused-health',
    })
    const pauseResponse = await ownerContext.request.patch(
      `/api/v1/projects/${project.id}/service-endpoints/${endpoint.id}`,
      { data: { healthCheckPaused: true } }
    )
    expect(pauseResponse.ok(), await pauseResponse.text()).toBeTruthy()
    await enrollMfaViaApi(ownerContext)
    const viewerEmail = uniqueEmail('epic20-viewer')
    await createInvitationViaApi(ownerContext, project.id, {
      email: viewerEmail,
      role: 'viewer',
    })

    const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(viewerEmail))
    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    await new InvitationAcceptPage(viewerPage).goto(token)
    await expect(viewerPage).toHaveURL(/\/register\?/)
    await new RegisterPage(viewerPage).passwordInput().fill(viewerPassword)
    await new RegisterPage(viewerPage).submitButton().click()
    await new LoginPage(viewerPage).goto()
    await new LoginPage(viewerPage).fillAndSubmit({
      email: viewerEmail,
      password: viewerPassword,
    })
    await expect(viewerPage).toHaveURL(/\/dashboard/)
    await viewerContext.request.post('/api/v1/users/me/onboarding', {
      data: { completed: true },
    })
    await setOrganizationRoleViaDb(owner.orgId, viewerEmail, 'viewer')
    await viewerPage.goto(`/projects/${project.id}/service-endpoints/${endpoint.id}`)
    await expect(viewerPage.getByRole('heading', { name: 'Monitoring paused' })).toBeVisible()
    await expect(viewerPage.getByText(/you can view this state/i)).toBeVisible()
    await expect(viewerPage.getByRole('button', { name: /resume monitoring/i })).toHaveCount(0)

    await viewerContext.close()
    // The invitation recipient is generated once above so the queued notification can be read
    // without exposing an invitation token through the API response.
    await ownerContext.close()
  })
})
