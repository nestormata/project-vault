import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi } from '../fixtures/api.js'
import { createProjectsViaDb } from '../fixtures/db.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

test.describe('J7 — dashboard project pagination', () => {
  test('AC-8: selects a project returned on the second API page', async ({ page, context }) => {
    const paginationPassword = ['e2e', 'J7', 'Pagination', 'Password', '123'].join('-')
    const owner = await registerAndLoginViaApi(context, {
      email: uniqueEmail('j7-pagination-owner'),
      password: paginationPassword,
      orgName: uniqueOrgName('J7 Pagination Org'),
    })

    // Create enough projects to cross the API's documented limit=100 boundary. The UI journey
    // remains the subject under test; the disposable E2E DB fixture avoids turning setup into 101
    // rate-limited project-creation requests. The deterministic timestamps place project 001 on
    // page 2 without relying on rapid-insert timestamp ties.
    await createProjectsViaDb({
      orgId: owner.orgId,
      userId: owner.userId,
      count: 101,
      namePrefix: 'J7 Pagination Project',
    })

    const pageTwoResponse = await context.request.get('/api/v1/projects?page=2&limit=100')
    expect(pageTwoResponse.ok(), await pageTwoResponse.text()).toBeTruthy()
    const pageTwoBody = (await pageTwoResponse.json()) as {
      data: { items: Array<{ id: string; name: string }>; hasNext: boolean }
    }
    const laterProject = pageTwoBody.data.items[0]
    expect(laterProject).toBeTruthy()
    expect(pageTwoBody.data.hasNext).toBe(false)
    if (!laterProject) throw new Error('expected a project on API page 2')

    await page.goto(`/dashboard?projectId=${encodeURIComponent(laterProject.id)}`)
    await expect(page.getByRole('option', { name: laterProject.name })).toHaveCount(1)
    await expect(page.getByText(`Showing data for ${laterProject.name}`)).toBeVisible()
    await expect(page.getByText('Project dashboard')).toBeVisible()
  })

  test('AC-8 security path: a foreign URL project ID falls back without disclosure', async ({
    browser,
  }) => {
    const foreignPassword = ['e2e', 'J7', 'Foreign', 'Password', '123'].join('-')
    const ownPassword = ['e2e', 'J7', 'Own', 'Password', '123'].join('-')
    const foreignContext = await browser.newContext()
    await registerAndLoginViaApi(foreignContext, {
      email: uniqueEmail('j7-foreign-owner'),
      password: foreignPassword,
      orgName: uniqueOrgName('J7 Foreign Org'),
    })
    const foreignProject = await createProjectViaApi(foreignContext, {
      name: 'J7 Foreign Project',
      slug: `j7-foreign-${Date.now()}`,
    })

    const ownContext = await browser.newContext()
    await registerAndLoginViaApi(ownContext, {
      email: uniqueEmail('j7-own-owner'),
      password: ownPassword,
      orgName: uniqueOrgName('J7 Own Org'),
    })
    const ownProject = await createProjectViaApi(ownContext, {
      name: 'J7 Own Project',
      slug: `j7-own-${Date.now()}`,
    })

    const page = await ownContext.newPage()
    await page.goto(`/dashboard?projectId=${encodeURIComponent(foreignProject.id)}`)
    await expect(page.getByText(`Showing data for ${ownProject.name}`)).toBeVisible()
    await expect(page.getByText(`Showing data for ${foreignProject.name}`)).toHaveCount(0)

    await foreignContext.close()
    await ownContext.close()
  })
})
