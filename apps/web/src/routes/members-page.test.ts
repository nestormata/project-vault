import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import { routeExists } from '$lib/test/route-exists.js'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const createInvitationMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/invitations.js', () => ({
  createInvitation: createInvitationMock,
  revokeInvitation: vi.fn(),
}))

vi.mock('$lib/api/org-users.js', () => ({
  changeProjectRole: vi.fn(),
  removeProjectMember: vi.fn(),
  transferOwnership: vi.fn(),
}))

import MembersPage from './(app)/projects/[projectId]/members/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    userId: 'u1',
    canManage: true as const,
    canManageMembers: true as const,
    canTransferOwnership: false as const,
    invitations: [],
    members: [],
    ...overrides,
  }
}

describe('/projects/[projectId]/members +page.svelte', () => {
  afterEach(() => cleanup())

  it('AC (pre-existing precedent): 403 mfa_required on invite shows a working /settings/security link', async () => {
    createInvitationMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'mfa_required', message: 'MFA enrollment is required for Owner and Admin roles.' },
        'MFA enrollment is required for Owner and Admin roles.'
      )
    )

    render(MembersPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /invite member/i }))
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'new@example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /send invite/i }))

    expect(await screen.findByText(/enable mfa to invite teammates/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /enable mfa/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
    // Regression guard: this precedent link 404'd — a matching href string alone doesn't prove
    // the destination is real.
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })
})
