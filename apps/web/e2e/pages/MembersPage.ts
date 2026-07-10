import type { Page } from '@playwright/test'

export class MembersPage {
  constructor(private readonly page: Page) {}

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/members`)
  }

  inviteMemberToggleButton() {
    return this.page.getByRole('button', { name: 'Invite member' })
  }

  emailInput() {
    return this.page.getByLabel('Email')
  }

  roleSelect() {
    return this.page.getByLabel('Role')
  }

  sendInviteButton() {
    return this.page.getByRole('button', { name: /Send invite/ })
  }

  errorAlert() {
    return this.page.getByRole('alert')
  }

  async invite(opts: { email: string; role: 'admin' | 'member' | 'viewer' }): Promise<void> {
    await this.inviteMemberToggleButton().click()
    await this.emailInput().fill(opts.email)
    await this.roleSelect().selectOption(opts.role)
    await this.sendInviteButton().click()
  }

  // displayName defaults to email at registration time (apps/api/src/modules/auth/service.ts),
  // so the members table's Email column reliably contains the invited user's email.
  memberRow(email: string) {
    return this.page.getByRole('row', {
      name: new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    })
  }

  cannotManageNotice() {
    return this.page.getByText('Only project owners and admins can manage invitations.')
  }
}
