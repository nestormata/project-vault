import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { enrollMfaViaApi, registerAndLoginViaApi, registerViaInvitation } from '../fixtures/auth.js'
import {
  createCredentialViaApi,
  createInvitationViaApi,
  createProjectViaApi,
  createServiceEndpointViaApi,
} from '../fixtures/api.js'
import { extractTokenFromAcceptUrl, readLatestInvitationAcceptUrl } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { LoginPage } from '../pages/LoginPage.js'

// J39 (Story 69.17, DW-606): a user invited to a project as `viewer` is read-only. The project's
// write controls are absent, and the API refuses the same writes made with the viewer's own
// session. The owner sees the controls on the same pages (the positive control).

const PROJECT_ROLE_DENIED = {
  code: 'insufficient_project_role',
  message: 'Your role in this project does not permit this action',
}

async function expectWriteControls(page: Page, projectId: string, visible: boolean) {
  const count = visible ? 1 : 0
  const heading = page.getByRole('heading', { level: 1 })
  await gotoHydrated(page, `/projects/${projectId}/credentials`, heading)
  await expect(page.locator(`a[href$="/projects/${projectId}/credentials/new"]`)).toHaveCount(count)
  await gotoHydrated(page, `/projects/${projectId}/service-endpoints`, heading)
  await expect(page.getByText('J39 endpoint')).toBeVisible()
  await expect(page.locator(`a[href$="/projects/${projectId}/service-endpoints/new"]`)).toHaveCount(
    count
  )
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(count)
  await expect(page.getByRole('button', { name: 'Pause monitoring' })).toHaveCount(count)
}

async function signInInvitedViewer(
  browserContext: BrowserContext,
  email: string,
  token: string
): Promise<Page> {
  const page = await browserContext.newPage()
  const password = 'e2e-Viewer-Password-123'
  await registerViaInvitation(page, token, password)
  const loginPage = new LoginPage(page)
  await loginPage.goto()
  await loginPage.fillAndSubmit({ email, password })
  await expect(page).toHaveURL(/\/dashboard/)
  await browserContext.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
  return page
}

test.describe('J39 — a project viewer is read-only', () => {
  test('write controls are hidden and direct API writes are refused for an invited viewer', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    await registerAndLoginViaApi(ownerContext, {
      email: uniqueEmail('j39-owner'),
      password: 'e2e-Owner-Password-123',
      orgName: uniqueOrgName('J39 Org'),
    })
    await ownerContext.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
    const project = await createProjectViaApi(ownerContext, {
      name: uniqueProjectName('J39 Project'),
      slug: `j39-project-${Date.now()}`,
    })
    const credential = await createCredentialViaApi(ownerContext, project.id, {
      name: 'J39 secret',
      value: 'j39-value-never-shown',
    })
    const endpoint = await createServiceEndpointViaApi(ownerContext, project.id, {
      name: 'J39 endpoint',
      url: 'https://example.com/health',
    })
    await enrollMfaViaApi(ownerContext)

    const viewerEmail = uniqueEmail('j39-viewer')
    await createInvitationViaApi(ownerContext, project.id, { email: viewerEmail, role: 'viewer' })
    const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(viewerEmail))
    const viewerContext = await browser.newContext()
    const viewerPage = await signInInvitedViewer(viewerContext, viewerEmail, token)

    const ownerPage = await ownerContext.newPage()
    await expectWriteControls(ownerPage, project.id, true)
    await expectWriteControls(viewerPage, project.id, false)

    const writes = [
      viewerContext.request.post(`/api/v1/projects/${project.id}/credentials`, {
        data: { name: 'J39 denied', value: 'x' },
      }),
      viewerContext.request.patch(`/api/v1/projects/${project.id}/credentials/${credential.id}`, {
        data: { description: 'denied' },
      }),
      viewerContext.request.post(`/api/v1/projects/${project.id}/service-endpoints`, {
        data: { name: 'J39 denied', url: 'https://example.com/denied' },
      }),
      viewerContext.request.patch(
        `/api/v1/projects/${project.id}/service-endpoints/${endpoint.id}`,
        { data: { healthCheckPaused: true } }
      ),
      viewerContext.request.delete(
        `/api/v1/projects/${project.id}/service-endpoints/${endpoint.id}`
      ),
    ]
    for (const response of await Promise.all(writes)) {
      expect(response.status()).toBe(403)
      expect(await response.json()).toEqual(PROJECT_ROLE_DENIED)
    }

    const read = await viewerContext.request.get(`/api/v1/projects/${project.id}/credentials`)
    expect(read.status()).toBe(200)
    const allowed = await ownerContext.request.post(`/api/v1/projects/${project.id}/credentials`, {
      data: { name: 'J39 allowed', value: 'y' },
    })
    expect(allowed.status()).toBe(201)

    await ownerContext.close()
    await viewerContext.close()
  })
})
