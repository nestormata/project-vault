import type { Page } from '@playwright/test'

export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/login')
  }

  emailInput() {
    return this.page.getByLabel('Email')
  }

  // Story 14.4 Task 3.1: Step A of the two-step login flow — email + Continue only.
  continueButton() {
    return this.page.getByRole('button', { name: /^Continue$/ })
  }

  passwordInput() {
    return this.page.getByLabel('Password')
  }

  submitButton() {
    return this.page.getByRole('button', { name: /Sign in/ })
  }

  // Story 14.4 Task 3.5: the SSO step's generic credential-input field/submit control, rendered
  // in place of the password field once the domain-lookup resolves ssoRequired:true.
  ssoCredentialInput() {
    return this.page.getByLabel('SSO credential')
  }

  ssoSubmitButton() {
    return this.page.getByRole('button', { name: /Continue with SSO/ })
  }

  useADifferentEmailButton() {
    return this.page.getByRole('button', { name: /Use a different email/ })
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

  // Story 14.4 Task 3.1: the login screen is now email-first/two-step — Step A (email +
  // Continue) always runs before the password field ever renders (AC-4), even for an email with
  // no SSO mapping (the overwhelming majority of this suite's existing journeys). Kept as the
  // same public method other journeys already call, so this is the only file that needed to
  // change to keep them passing.
  async fillAndSubmit(opts: { email: string; password: string }): Promise<void> {
    await this.emailInput().fill(opts.email)
    await this.continueButton().click()
    await this.passwordInput().waitFor({ state: 'visible' })
    await this.passwordInput().fill(opts.password)
    await this.submitButton().click()
  }

  // Story 14.4 Task 3.5: drives the full email -> SSO step -> credential submit path.
  async fillAndContinueToSso(email: string): Promise<void> {
    await this.emailInput().fill(email)
    await this.continueButton().click()
    await this.ssoCredentialInput().waitFor({ state: 'visible' })
  }

  async submitSsoCredential(credential: string): Promise<void> {
    await this.ssoCredentialInput().fill(credential)
    await this.ssoSubmitButton().click()
  }

  async submitMfaCode(totp: string): Promise<void> {
    await this.totpInput().fill(totp)
    await this.mfaSubmitButton().click()
  }
}
