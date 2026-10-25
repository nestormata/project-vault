import { expect, test } from '@playwright/test'
import { createProject, open, precedes, seedOrgOwner, trackHydrationMismatch } from './fixtures.js'

// Story 69.12 AC-4 / 69-6 AC-8 case 12 (probe order): the pack fills sub-region points four pages
// gained when their big region components were split (batch 3). Each fill must land right AFTER the
// PV section it targets (DOM order), not at the end of the page. Render-only fills.
const ID = {
  projectSlug: 'mock-p12-project-slug',
  machineRole: 'mock-p12-machine-role',
  auditExportForm: 'mock-p12-audit-export-form',
  exportKey: 'mock-p12-export-key',
} as const
const SENTINEL = 'mock-ui-pack:m3-p12'

test.describe('M3 sub-region points on the new project form, the new machine user form, the audit export and the project export', () => {
  test('works: the new project fill sits after the slug hint and before the description', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p12-new-project')
    await open(page, '/projects/new', page.getByTestId(ID.projectSlug))
    const fill = page.getByTestId(ID.projectSlug)
    await expect(fill).toContainText(`${SENTINEL}-project.new.slug`)
    expect(
      await precedes(page.getByText('Use 3-50 lowercase letters, numbers, and hyphens.'), fill)
    ).toBe(true)
    expect(await precedes(fill, page.locator('#project-description'))).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: the new machine user fill sits after the role help and before the description', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p12-machine-user')
    const projectId = await createProject(context, 'P12 Machine Project')
    await open(page, `/projects/${projectId}/machine-users/new`, page.getByTestId(ID.machineRole))
    const fill = page.getByTestId(ID.machineRole)
    await expect(fill).toContainText(`${SENTINEL}-project.machine-users-new.role`)
    expect(await precedes(page.locator('#machine-user-role-help'), fill)).toBe(true)
    expect(await precedes(fill, page.locator('#machine-user-description'))).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: the audit export fill sits after the date range and before the verify card', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p12-audit')
    await open(page, '/settings/audit', page.getByTestId(ID.auditExportForm))
    const fill = page.getByTestId(ID.auditExportForm)
    await expect(fill).toContainText(`${SENTINEL}-settings.audit.export-form`)
    expect(await precedes(page.getByRole('button', { name: 'Export CSV' }), fill)).toBe(true)
    // After the export card's heading too (DW-610 item 5), not just after the button.
    expect(await precedes(page.getByRole('heading', { name: 'Export', exact: true }), fill)).toBe(
      true
    )
    expect(await precedes(fill, page.locator('#verify-from'))).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: the project export fill sits after the export button', async ({ page, context }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p12-export')
    const projectId = await createProject(context, 'P12 Export Project')
    await open(page, `/projects/${projectId}`, page.getByTestId(ID.exportKey))
    const fill = page.getByTestId(ID.exportKey)
    await expect(fill).toContainText(`${SENTINEL}-project.detail.export-key`)
    expect(await precedes(page.getByRole('button', { name: 'Export project' }), fill)).toBe(true)
    // Inside the export section (DW-610 item 5), after its description, not at the page's end.
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Export project' }),
    })
    await expect(section.getByTestId(ID.exportKey)).toBeVisible()
    expect(await precedes(page.getByText(/shown to you exactly once/), fill)).toBe(true)
    expect(mismatches()).toEqual([])
  })
})
