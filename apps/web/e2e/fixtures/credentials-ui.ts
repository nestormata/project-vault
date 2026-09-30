import type { Page } from '@playwright/test'
import { CredentialsPage } from '../pages/CredentialsPage.js'

type LoginTemplateFormOptions = {
  name: string
  field1Value: string
  field2Value: string
  // Runs after the template is selected (fields are populated with default names) but before
  // the field values are filled and the form submitted — lets a caller assert on or rename the
  // pre-populated field names without duplicating the surrounding fill/submit steps.
  beforeSubmit?: () => Promise<void>
}

// Shared by every journey that needs a Login-template secret filled in through the real UI
// (J5, J6, J12, J14, J18) — factored out after jscpd flagged the inline form-fill/submit sequence
// as a duplicate across specs (`.jscpd.json`'s threshold is 0%, so any literal repeat fails CI).
// Fills the form but does not submit it, so a journey that expects the submit to be refused
// (J5's colliding-key case) can reuse it too.
export async function fillLoginTemplateCredentialForm(
  page: Page,
  projectId: string,
  opts: LoginTemplateFormOptions
): Promise<CredentialsPage> {
  const credentialsPage = new CredentialsPage(page)
  await credentialsPage.gotoNew(projectId)
  await credentialsPage.nameInput().fill(opts.name)
  await credentialsPage.templateSelect().selectOption('login')
  await opts.beforeSubmit?.()
  await credentialsPage.fieldValueInput(1).fill(opts.field1Value)
  await credentialsPage.fieldValueInput(2).fill(opts.field2Value)
  return credentialsPage
}

export async function createLoginTemplateCredentialViaUi(
  page: Page,
  projectId: string,
  opts: LoginTemplateFormOptions
): Promise<void> {
  const credentialsPage = await fillLoginTemplateCredentialForm(page, projectId, opts)
  await credentialsPage.submitButton().click()
  await page.waitForURL(`**/projects/${projectId}/credentials/*`)
}
