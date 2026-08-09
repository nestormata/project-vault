import type { Page } from '@playwright/test'

// Shared by every journey that needs a Login-template secret created through the real UI
// (J5, J14, ...) — factored out after jscpd flagged the inline form-fill/submit sequence as a
// duplicate across specs (`.jscpd.json`'s threshold is 0%, so any literal repeat fails CI).
export async function createLoginTemplateCredentialViaUi(
  page: Page,
  projectId: string,
  opts: {
    name: string
    field1Value: string
    field2Value: string
    // Runs after the template is selected (fields are populated with default names) but before
    // the field values are filled and the form submitted — lets a caller assert on or rename the
    // pre-populated field names without duplicating the surrounding fill/submit steps.
    beforeSubmit?: () => Promise<void>
  }
): Promise<void> {
  await page.goto(`/projects/${projectId}/credentials/new`)
  await page.getByLabel('Name', { exact: true }).fill(opts.name)
  await page.getByLabel('Template', { exact: true }).selectOption('login')
  await opts.beforeSubmit?.()
  await page.getByLabel('Field 1 value').fill(opts.field1Value)
  await page.getByLabel('Field 2 value').fill(opts.field2Value)
  await page.getByRole('button', { name: 'Create credential' }).click()
  await page.waitForURL(`**/projects/${projectId}/credentials/*`)
}
