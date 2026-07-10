import type { Page } from '@playwright/test'

export class SecurityPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/settings/security')
  }

  startEnrollmentButton() {
    return this.page.getByRole('button', { name: 'Set up authenticator app' })
  }

  secretText() {
    return this.page.locator('p.font-mono')
  }

  totpInput() {
    return this.page.getByLabel(/authenticator code/i)
  }

  verifyButton() {
    return this.page.getByRole('button', { name: 'Verify and enable' })
  }

  saveRecoveryCodesButton() {
    return this.page.getByRole('button', { name: "I've saved these codes" })
  }

  errorAlert() {
    return this.page.getByRole('alert')
  }

  mfaEnabledHeading() {
    return this.page.getByRole('heading', { name: 'MFA is enabled' })
  }

  async enroll(secretExtractor: (secret: string) => string): Promise<void> {
    await this.startEnrollmentButton().click()
    const secret = (await this.secretText().textContent())?.trim() ?? ''
    await this.totpInput().fill(secretExtractor(secret))
    await this.verifyButton().click()
    await this.saveRecoveryCodesButton().click()
  }
}
