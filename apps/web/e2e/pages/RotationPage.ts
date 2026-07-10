import type { Page } from '@playwright/test'

export class RotationPage {
  constructor(private readonly page: Page) {}

  async gotoInitiate(projectId: string, credentialId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/credentials/${credentialId}/rotate`)
  }

  async gotoDetail(projectId: string, credentialId: string, rotationId: string): Promise<void> {
    await this.page.goto(
      `/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}`
    )
  }

  // --- Initiate form ---
  newValueInput() {
    return this.page.getByLabel(/new value/i)
  }

  startRotationButton() {
    return this.page.getByRole('button', { name: /start rotation/i })
  }

  errorAlert() {
    return this.page.getByRole('alert')
  }

  async initiate(newValue: string): Promise<void> {
    await this.newValueInput().fill(newValue)
    await this.startRotationButton().click()
  }

  // --- Checklist page ---
  statusBadge() {
    return this.page.getByText(/^(in_progress|completed|abandoned|stale_recovery)$/)
  }

  confirmButton(index = 0) {
    return this.page.getByRole('button', { name: 'Confirm' }).nth(index)
  }

  acknowledgeNoDependenciesCheckbox() {
    return this.page.getByRole('checkbox', {
      name: 'I confirm this credential is updated in all consuming systems',
    })
  }

  completeRotationButton() {
    return this.page.getByRole('button', { name: /complete rotation/i })
  }

  completeErrorBanner() {
    return this.page.getByRole('alert')
  }
}
