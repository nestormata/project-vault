import { expect, test } from '@playwright/test'
import { createProject, open, precedes, seedOrgOwner, trackHydrationMismatch } from './fixtures.js'

// Story 69.11 AC-4 / 69-6 AC-8 case 12 (probe order): the pack fills sub-region points four pages
// gained when their big region components were split (batch 2). Each fill must land right AFTER the
// PV section it targets (DOM order), not at the end of the page. Render-only fills; the existing
// mechanism cases are untouched.
const ID = {
  projectsResults: 'mock-p11-projects-results',
  notificationsEmpty: 'mock-p11-notifications-empty',
  importKey: 'mock-p11-import-key',
  credentialTags: 'mock-p11-credential-tags',
} as const
const SENTINEL = 'mock-ui-pack:m3-p11'

test.describe('M3 sub-region points on the projects list, the inbox, the import and the new secret form', () => {
  test('works: the projects list fill sits after the project cards', async ({ page, context }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p11-projects')
    await createProject(context, 'P11 Region Project')
    await open(page, '/projects', page.getByTestId(ID.projectsResults))
    const fill = page.getByTestId(ID.projectsResults)
    await expect(fill).toContainText(`${SENTINEL}-project.home.results`)
    expect(await precedes(page.getByRole('link', { name: 'View project' }).last(), fill)).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: the inbox fill sits after the empty-state notice', async ({ page, context }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p11-inbox')
    await open(page, '/notifications', page.getByTestId(ID.notificationsEmpty))
    const fill = page.getByTestId(ID.notificationsEmpty)
    await expect(fill).toContainText(`${SENTINEL}-notifications.home.empty`)
    expect(await precedes(page.getByText('No notifications', { exact: true }), fill)).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: the import fill sits between the export key help and the project name field', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p11-import')
    await open(page, '/projects/import', page.getByTestId(ID.importKey))
    const fill = page.getByTestId(ID.importKey)
    await expect(fill).toContainText(`${SENTINEL}-project.import.export-key`)
    expect(await precedes(page.locator('#export-key-help'), fill)).toBe(true)
    expect(await precedes(fill, page.locator('#project-name'))).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: the new secret fill sits after the tags help and before the submit row', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p11-new-secret')
    const projectId = await createProject(context, 'P11 Secret Project')
    await open(page, `/projects/${projectId}/credentials/new`, page.getByTestId(ID.credentialTags))
    const fill = page.getByTestId(ID.credentialTags)
    await expect(fill).toContainText(`${SENTINEL}-project.credentials-new.tags`)
    expect(await precedes(page.locator('#credential-tags-help'), fill)).toBe(true)
    expect(await precedes(fill, page.getByRole('button', { name: 'Create secret' }))).toBe(true)
    expect(mismatches()).toEqual([])
  })
})
