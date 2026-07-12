import { describe, expect, it } from 'vitest'
import { renderProjectInvitationCreated } from './project-invitation-created.js'

const BASE_PAYLOAD = {
  projectId: 'proj-1',
  projectName: 'Acme Vault',
  role: 'member' as const,
  acceptUrl: 'https://vault.example.com/invitations/abc/accept',
}

describe('renderProjectInvitationCreated', () => {
  it('names the inviter when inviterEmail is present', () => {
    const result = renderProjectInvitationCreated({ ...BASE_PAYLOAD, inviterEmail: 'a@b.com' })

    expect(result.subject).toBe("[Project Vault] You've been invited to Acme Vault")
    expect(result.text).toContain('a@b.com invited you to join Acme Vault')
    expect(result.text).toContain(BASE_PAYLOAD.acceptUrl)
    expect(result.html).toContain('a@b.com')
  })

  it('falls back to "A teammate" when inviterEmail is null', () => {
    const result = renderProjectInvitationCreated({ ...BASE_PAYLOAD, inviterEmail: null })

    expect(result.text).toContain('A teammate invited you to join Acme Vault')
    expect(result.html).toContain('A teammate')
  })

  it('HTML-escapes projectName/role/acceptUrl containing special characters', () => {
    const result = renderProjectInvitationCreated({
      projectId: 'proj-1',
      projectName: '<script>alert(1)</script>',
      role: 'admin',
      acceptUrl: 'https://vault.example.com/?a=1&b=2',
      inviterEmail: null,
    })

    expect(result.html).not.toContain('<script>alert(1)</script>')
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(result.html).toContain('&amp;b=2')
  })
})
