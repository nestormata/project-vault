import type { Page } from '@playwright/test'

export class InvitationAcceptPage {
  constructor(private readonly page: Page) {}

  async goto(token?: string): Promise<void> {
    const query = token !== undefined ? `?token=${encodeURIComponent(token)}` : ''
    await this.page.goto(`/invitations/accept${query}`)
  }

  invalidHeading() {
    return this.page.getByRole('heading', { name: 'Invitation not available' })
  }

  invalidReasonText(text: string) {
    return this.page.getByText(text)
  }
}
