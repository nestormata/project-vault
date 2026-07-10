import type { Page } from '@playwright/test'

// First-run OnboardingDialog/OnboardingWizard renders as a modal dialog over /dashboard, not a
// standalone route (see Background's confirmed-routes table). Step 1 creates the org's first
// project; Step 2 creates the first credential inline (owner/admin/member roles must create one
// to advance — there is no skip for non-viewer roles); Step 3 finishes.
export class OnboardingPage {
  constructor(private readonly page: Page) {}

  dialog() {
    return this.page.getByRole('dialog')
  }

  // --- Step 1: create project ---
  projectNameInput() {
    return this.page.getByLabel('Project name')
  }

  createProjectButton() {
    return this.page.getByRole('button', { name: 'Create Project' })
  }

  step1ContinueButton() {
    return this.page.getByRole('button', { name: "Got it — Let's add a credential" })
  }

  async completeStep1(projectName: string): Promise<void> {
    await this.projectNameInput().fill(projectName)
    await this.createProjectButton().click()
    await this.step1ContinueButton().click()
  }

  // --- Step 2: create first credential ---
  credentialNameInput() {
    return this.page.getByLabel('Name (public identifier)')
  }

  credentialValueInput() {
    return this.page.getByLabel('Credential value')
  }

  saveCredentialButton() {
    return this.page.getByRole('button', { name: 'Save Credential' })
  }

  nextButton() {
    return this.page.getByRole('button', { name: 'Next' })
  }

  async completeStep2(opts: { name: string; value: string }): Promise<void> {
    await this.credentialNameInput().fill(opts.name)
    await this.credentialValueInput().fill(opts.value)
    await this.saveCredentialButton().click()
    await this.nextButton().click()
  }

  // --- Step 3: finish ---
  goToDashboardButton() {
    return this.page.getByRole('button', { name: 'Go to Dashboard' })
  }

  async completeStep3(): Promise<void> {
    await this.goToDashboardButton().click()
  }
}
