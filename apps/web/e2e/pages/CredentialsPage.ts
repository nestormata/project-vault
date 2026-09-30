import type { Page } from '@playwright/test'
import { gotoHydrated } from '../fixtures/hydration.js'

export class CredentialsPage {
  constructor(private readonly page: Page) {}

  // Hydration-armed: the Template <select>'s `onchange` builds the Field rows, so a
  // selectOption() that lands before hydration leaves no "Field 1 value" input at all.
  async gotoNew(projectId: string): Promise<void> {
    await gotoHydrated(this.page, `/projects/${projectId}/credentials/new`, this.nameInput())
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

  templateSelect() {
    return this.page.getByLabel('Template', { exact: true })
  }

  fieldNameInput(index: number) {
    return this.page.getByLabel(`Field ${index} name`, { exact: true })
  }

  fieldValueInput(index: number) {
    return this.page.getByLabel(`Field ${index} value`, { exact: true })
  }

  // PR #334 (0a98af30) renamed the visible copy Credential -> Secret (FormSubmitRow's
  // submitLabel on credentials/new/+page.svelte). The one place every journey reads it from.
  submitButton() {
    return this.page.getByRole('button', { name: 'Create secret', exact: true })
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
