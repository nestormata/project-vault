import type { Page } from '@playwright/test'

export class CredentialsPage {
  constructor(private readonly page: Page) {}

  async gotoNew(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/credentials/new`)
  }

  async gotoDetail(projectId: string, credentialId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/credentials/${credentialId}`)
  }

  async gotoList(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/credentials`)
  }

  // --- New credential form ---
  nameInput() {
    return this.page.getByLabel('Name', { exact: true })
  }

  valueInput() {
    return this.page.getByLabel('Value', { exact: true })
  }

  submitButton() {
    return this.page.getByRole('button', { name: 'Create credential' })
  }

  async createCredential(opts: { name: string; value: string }): Promise<void> {
    await this.nameInput().fill(opts.name)
    await this.valueInput().fill(opts.value)
    await this.submitButton().click()
  }

  // --- Detail page ---
  revealButton() {
    return this.page.getByRole('button', { name: 'Reveal value' })
  }

  revealedValueText() {
    return this.page.locator('pre')
  }

  errorAlert() {
    return this.page.getByRole('alert')
  }

  credentialLink(name: string) {
    return this.page.getByRole('link', { name })
  }
}
