import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import { routeExists } from '$lib/test/route-exists.js'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const createInvitationMock = vi.hoisted(() => vi.fn())
const revokeInvitationMock = vi.hoisted(() => vi.fn())
const changeProjectRoleMock = vi.hoisted(() => vi.fn())
const removeProjectMemberMock = vi.hoisted(() => vi.fn())
const transferOwnershipMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/invitations.js', () => ({
  createInvitation: createInvitationMock,
  revokeInvitation: revokeInvitationMock,
}))

vi.mock('$lib/api/org-users.js', () => ({
  changeProjectRole: changeProjectRoleMock,
  removeProjectMember: removeProjectMemberMock,
  transferOwnership: transferOwnershipMock,
}))

import MembersPage from './(app)/projects/[projectId]/members/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const owner = {
  userId: 'u-owner',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'owner' as const,
}
const member = {
  userId: 'u-member',
  email: 'member@example.com',
  displayName: 'Member',
  role: 'member' as const,
}

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
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateAllMock.mockResolvedValue(undefined)
  })

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

  it('renders read-only and empty states without management actions', () => {
    render(MembersPage, {
      props: { data: baseData({ canManage: false, canManageMembers: false }) },
    })

    expect(screen.getByText(/only project owners and admins/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /invite member/i })).toBeNull()
    expect(screen.queryByText(/team members/i)).toBeNull()
  })

  it('renders empty member and invitation states for a manager', () => {
    render(MembersPage, { props: { data: baseData() } })
    expect(screen.getByText(/no members yet/i)).toBeTruthy()
    expect(screen.getByText(/no pending invitations/i)).toBeTruthy()
  })

  it('invites with the selected role, invalidates, and closes the form', async () => {
    createInvitationMock.mockResolvedValue({})
    render(MembersPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /invite member/i }))
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'new@example.com' },
    })
    await fireEvent.change(screen.getByLabelText(/role/i), { target: { value: 'admin' } })
    await fireEvent.click(screen.getByRole('button', { name: /send invite/i }))

    expect(createInvitationMock).toHaveBeenCalledWith(expect.anything(), projectId, {
      email: 'new@example.com',
      role: 'admin',
    })
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText(/email/i)).toBeNull()
  })

  it('guards a duplicate invitation while the first submission is pending', async () => {
    let resolveInvite!: () => void
    createInvitationMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvite = resolve
      })
    )
    render(MembersPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: /invite member/i }))
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'pending@example.com' },
    })
    const submit = screen.getByRole('button', { name: /send invite/i })
    await fireEvent.click(submit)
    await fireEvent.click(submit)
    expect(createInvitationMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /sending/i })).toBeTruthy()
    resolveInvite()
    await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalledTimes(1))
  })

  it.each([
    [
      new ApiClientError(409, { code: 'already_member', message: 'exists' }, 'exists'),
      /already a project member/i,
    ],
    [new Error('invite exploded'), /invite exploded/i],
    [{ reason: 'unknown' }, /failed to send invitation/i],
  ])('maps invitation failures', async (failure, expected) => {
    createInvitationMock.mockRejectedValue(failure)
    render(MembersPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: /invite member/i }))
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'new@example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /send invite/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('changes a non-owner role once while busy and invalidates', async () => {
    let resolveChange!: () => void
    changeProjectRoleMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveChange = resolve
      })
    )
    render(MembersPage, { props: { data: baseData({ members: [owner, member] }) } })

    const select = screen.getByLabelText(/role for member@example.com/i)
    await fireEvent.change(select, { target: { value: 'viewer' } })
    await fireEvent.change(select, { target: { value: 'admin' } })
    expect(changeProjectRoleMock).toHaveBeenCalledTimes(1)
    expect(changeProjectRoleMock).toHaveBeenCalledWith(
      expect.anything(),
      member.userId,
      projectId,
      'viewer'
    )
    resolveChange()
    await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalledTimes(1))
  })

  it.each([
    [new Error('role exploded'), /role exploded/i],
    [false, /failed to change role/i],
  ])('maps role-change failures', async (failure, expected) => {
    changeProjectRoleMock.mockRejectedValue(failure)
    render(MembersPage, { props: { data: baseData({ members: [member] }) } })
    await fireEvent.change(screen.getByLabelText(/role for member@example.com/i), {
      target: { value: 'admin' },
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('removes a member and blocks duplicate mutation while pending', async () => {
    let resolveRemove!: () => void
    removeProjectMemberMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRemove = resolve
      })
    )
    render(MembersPage, { props: { data: baseData({ members: [member] }) } })
    const remove = screen.getByRole('button', { name: /^remove$/i })
    await fireEvent.click(remove)
    await fireEvent.click(remove)
    expect(removeProjectMemberMock).toHaveBeenCalledTimes(1)
    resolveRemove()
    await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalledTimes(1))
  })

  it.each([
    [
      new ApiClientError(409, { code: 'last_owner', message: 'last' }, 'last'),
      /cannot remove the last owner/i,
    ],
    [new Error('remove exploded'), /remove exploded/i],
    [null, /failed to remove member/i],
  ])('maps member-removal failures', async (failure, expected) => {
    removeProjectMemberMock.mockRejectedValue(failure)
    render(MembersPage, { props: { data: baseData({ members: [member] }) } })
    await fireEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('transfers ownership only after a target is selected', async () => {
    transferOwnershipMock.mockResolvedValue({})
    render(MembersPage, {
      props: {
        data: baseData({
          canTransferOwnership: true,
          members: [owner, member],
        }),
      },
    })
    const transfer = screen.getByRole('button', { name: /^transfer$/i })
    expect((transfer as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.change(screen.getByLabelText(/transfer ownership/i), {
      target: { value: member.userId },
    })
    await fireEvent.click(transfer)
    expect(transferOwnershipMock).toHaveBeenCalledWith(expect.anything(), projectId, member.userId)
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [new Error('transfer exploded'), /transfer exploded/i],
    [undefined, /failed to transfer ownership/i],
  ])('maps ownership-transfer failures', async (failure, expected) => {
    transferOwnershipMock.mockRejectedValue(failure)
    render(MembersPage, {
      props: { data: baseData({ canTransferOwnership: true, members: [owner, member] }) },
    })
    await fireEvent.change(screen.getByLabelText(/transfer ownership/i), {
      target: { value: member.userId },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^transfer$/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('formats expired, hour, and day invitation boundaries and revokes once while busy', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'))
    let resolveRevoke!: () => void
    revokeInvitationMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRevoke = resolve
      })
    )
    const invitations = [
      {
        id: 'expired',
        email: 'expired@example.com',
        roleToAssign: 'viewer',
        expiresAt: '2026-07-10T11:00:00.000Z',
      },
      {
        id: 'hours',
        email: 'hours@example.com',
        roleToAssign: 'member',
        expiresAt: '2026-07-11T11:00:00.000Z',
      },
      {
        id: 'days',
        email: 'days@example.com',
        roleToAssign: 'admin',
        expiresAt: '2026-07-12T12:00:00.000Z',
      },
    ]
    render(MembersPage, { props: { data: baseData({ invitations }) } })
    expect(screen.getByText('expired')).toBeTruthy()
    expect(screen.getByText('expires in 23h')).toBeTruthy()
    expect(screen.getByText('expires in 2d')).toBeTruthy()
    const revokeButtons = screen.getAllByRole('button', { name: /revoke/i })
    await fireEvent.click(revokeButtons[0] as HTMLElement)
    await fireEvent.click(revokeButtons[1] as HTMLElement)
    expect(revokeInvitationMock).toHaveBeenCalledTimes(1)
    resolveRevoke()
    await vi.runAllTimersAsync()
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
