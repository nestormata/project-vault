import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createCredentialViaApi, createProjectViaApi } from '../fixtures/api.js'
import { gotoHydrated } from '../fixtures/hydration.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

// J35 (Story 62-2): export -> copy the key -> import the downloaded file with the Show/Hide
// toggle. Covers AC-1 (Copy + "Copied to clipboard"), AC-2 (password input with toggle), AC-4
// (count list), AC-5 (the same-org import is named "(imported)") and AC-6 (way back).
// Chromium only: the clipboard permissions below are a Chromium feature.

const PASSWORD = 'e2e-J35-Owner-Password-123'

test.describe('J35 — project export and import', () => {
  test('exports with a copyable key, then imports the downloaded file as a distinguishable project', async ({
    page,
    context,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])

    await registerAndLoginViaApi(context, {
      email: uniqueEmail('j35-owner'),
      password: PASSWORD,
      orgName: uniqueOrgName('J35 Org'),
    })
    await context.request.post('/api/v1/users/me/onboarding', { data: { completed: true } })
    const projectName = uniqueProjectName('J35 Project')
    const project = await createProjectViaApi(context, {
      name: projectName,
      slug: `j35-${Date.now()}`,
    })
    await createCredentialViaApi(context, project.id, { name: 'j35-secret', value: 'j35-value' })

    // --- Export: the key is revealed once, with a Copy button and a live confirmation ---
    const exportButton = page.getByRole('button', { name: 'Export project' })
    await gotoHydrated(page, `/projects/${project.id}`, exportButton)
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()])
    const exportPath = testInfo.outputPath('j35.pvexport')
    await download.saveAs(exportPath)

    const keyBlock = page.locator('code')
    await expect(keyBlock).toBeVisible()
    const status = page.getByRole('status')
    await expect(status).toHaveText('')
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(status).toHaveText('Copied to clipboard')
    const exportKey = (await page.evaluate(() => navigator.clipboard.readText())).trim()
    expect(exportKey.length).toBeGreaterThan(20)
    await expect(keyBlock).toHaveText(exportKey)
    // The explanatory paragraph is collapsed while the reveal's own warning is shown.
    await expect(page.getByText(/shown to you exactly once/)).toHaveCount(0)

    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(keyBlock).toHaveCount(0)

    // --- Import: hardened key input, Show/Hide toggle, result with counts ---
    const fileInput = page.locator('#pvexport-file')
    await gotoHydrated(page, '/projects/import', fileInput)
    await fileInput.setInputFiles(exportPath)
    const keyInput = page.locator('#export-key')
    await expect(keyInput).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Show export key' }).click()
    await expect(keyInput).toHaveAttribute('type', 'text')
    await keyInput.fill(exportKey)
    await page.getByRole('button', { name: 'Hide export key' }).click()
    await expect(keyInput).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Import project' }).click()

    await expect(page.getByText('Import complete')).toBeVisible()
    await expect(page.getByText('Imported as a new project:')).toBeVisible()
    await expect(page.locator('strong', { hasText: `${projectName} (imported)` })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: 'Secrets: 1' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects'
    )

    await page.getByRole('button', { name: 'View project' }).click()
    await expect(page).toHaveURL(/\/projects\/(?!import)[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { name: `${projectName} (imported)` })).toBeVisible()
  })
})
