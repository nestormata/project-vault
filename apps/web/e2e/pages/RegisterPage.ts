import type { Page } from '@playwright/test'

// Page Object Model — thin wrapper over page.getByRole(...)/getByLabel(...) locators, matching
// this repo's existing apps/web Vitest convention (see Dev Notes: "Role-based, accessible-first
// locators"). Deliberately no data-testid.
export class RegisterPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/register')
  }

  emailInput() {
    return this.page.getByLabel('Email')
  }

  orgNameInput() {
    return this.page.getByLabel('Organization name')
  }

  passwordInput() {
    return this.page.getByLabel('Password')
  }

  submitButton() {
    return this.page.getByRole('button', { name: 'Create account' })
  }

  errorAlert() {
    return this.page.getByRole('alert')
  }

  async fillAndSubmit(opts: { email: string; password: string; orgName?: string }): Promise<void> {
    await this.emailInput().fill(opts.email)
    if (opts.orgName !== undefined) {
      await this.orgNameInput().fill(opts.orgName)
    }
    await this.passwordInput().fill(opts.password)
    await this.submitButton().click()
  }
}
