import type { Page } from '@playwright/test'

export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/login')
  }

  emailInput() {
    return this.page.getByLabel('Email')
  }

  passwordInput() {
    return this.page.getByLabel('Password')
  }

  submitButton() {
    return this.page.getByRole('button', { name: /Sign in/ })
  }

  errorAlert() {
    return this.page.getByRole('alert')
  }

  // Rendered inline on the same /login page once the initial POST /login response is a
  // pendingMfa challenge — there is no separate /login/mfa URL (confirmed shipped behavior).
  totpInput() {
    return this.page.getByLabel('Authenticator code')
  }

  mfaSubmitButton() {
    return this.page.getByRole('button', { name: /Verify MFA code/ })
  }

  async fillAndSubmit(opts: { email: string; password: string }): Promise<void> {
    await this.emailInput().fill(opts.email)
    await this.passwordInput().fill(opts.password)
    await this.submitButton().click()
  }

  async submitMfaCode(totp: string): Promise<void> {
    await this.totpInput().fill(totp)
    await this.mfaSubmitButton().click()
  }
}
