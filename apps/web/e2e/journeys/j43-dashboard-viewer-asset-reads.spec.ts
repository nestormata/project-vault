import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { createProjectViaApi } from '../fixtures/api.js'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import {
  describeEachAppearance,
  expectAppearanceApplied,
  expectNoHorizontalOverflow,
} from '../fixtures/appearance.js'
import { setOrganizationRoleViaDb } from '../fixtures/db.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'
import { inviteAndSignIn } from '../fixtures/invited-user.js'

const OWNER_PASSWORD = 'e2e-Owner-Password-123'
const VIEWER_PASSWORD = 'e2e-Viewer-Password-123'

// J43 (Story 72.20): an organization user whose role may not read certificates or domains opens the
// dashboard. The load used to leave both rejected reads unhandled, which ends the Node web process
// (ERR_CONNECTION_RESET). The journey proves the page renders with a role message in place of the
// two counts, and that the server still answers afterwards (a second request, and another user).

async function openDashboard(page: Page): Promise<void> {
  await gotoHydrated(page, '/dashboard', page.getByRole('heading', { name: 'Secret overview' }))
}

describeEachAppearance('J43 dashboard viewer asset reads', (appearance) => {
  test('AC2/AC6: a viewer gets the role message, and the web server keeps serving', async ({
    page,
    context,
    browser,
  }) => {
    const { orgId } = await registerAndLoginViaApi(context, {
      email: uniqueEmail('j43-owner'),
      password: OWNER_PASSWORD,
      orgName: uniqueOrgName('J43 Org'),
    })
    const projectName = uniqueProjectName('J43 Project')
    const project = await createProjectViaApi(context, {
      name: projectName,
      slug: `j43-${randomUUID().slice(0, 12)}`,
    })
    const viewer = await inviteAndSignIn(context, browser, {
      projectId: project.id,
      role: 'member',
      label: 'j43-viewer',
      password: VIEWER_PASSWORD,
    })
    await setOrganizationRoleViaDb(orgId, viewer.email, 'viewer')
    const me = await viewer.page.request.get('/api/v1/auth/me')
    expect(((await me.json()) as { data: { orgRole: string } }).data.orgRole).toBe('viewer')

    await viewer.page.setViewportSize({ ...appearance.viewport })
    await viewer.page.emulateMedia({ colorScheme: appearance.colorScheme })
    await openDashboard(viewer.page)
    await expectAppearanceApplied(viewer.page, appearance)
    await expect(
      viewer.page.getByText('Certificates are not available for your role.')
    ).toBeVisible()
    await expect(viewer.page.getByText('Domains are not available for your role.')).toBeVisible()
    await expect(viewer.page.getByText('Certificates unavailable right now.')).toHaveCount(0)
    await expectNoHorizontalOverflow(viewer.page)

    await viewer.page.reload()
    await expect(viewer.page.getByRole('heading', { name: 'Secret overview' })).toBeVisible()

    // The owner can read both lists, so the same page shows counts instead (positive control, and
    // proof the process the viewer just loaded is still serving other people).
    await page.setViewportSize({ ...appearance.viewport })
    await page.emulateMedia({ colorScheme: appearance.colorScheme })
    await openDashboard(page)
    await expect(page.getByText('0 certificates')).toBeVisible()
    await expect(page.getByText('0 domains')).toBeVisible()
    await expect(page.getByText('are not available for your role')).toHaveCount(0)
  })
})
