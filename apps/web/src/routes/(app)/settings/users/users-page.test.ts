import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const gotoMock = vi.hoisted(() => vi.fn())
const updateUserDormancyThresholdMock = vi.hoisted(() => vi.fn())
const updateMachineKeyDormancyThresholdMock = vi.hoisted(() => vi.fn())
const pseudonymizeUserMock = vi.hoisted(() => vi.fn())
const createErasureRequestMock = vi.hoisted(() => vi.fn())
const changeProjectRoleMock = vi.hoisted(() => vi.fn())
const deactivateOrgUserMock = vi.hoisted(() => vi.fn())
const removeOrgUserMock = vi.hoisted(() => vi.fn())
const sendRecoveryLinkMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
  goto: gotoMock,
}))

vi.mock('$lib/api/organization-settings.js', () => ({
  updateUserDormancyThreshold: updateUserDormancyThresholdMock,
  updateMachineKeyDormancyThreshold: updateMachineKeyDormancyThresholdMock,
}))

vi.mock('$lib/api/compliance.js', () => ({
  pseudonymizeUser: pseudonymizeUserMock,
  createErasureRequest: createErasureRequestMock,
}))

vi.mock('$lib/api/org-users.js', () => ({
  changeProjectRole: changeProjectRoleMock,
  deactivateOrgUser: deactivateOrgUserMock,
  removeOrgUser: removeOrgUserMock,
  sendRecoveryLink: sendRecoveryLinkMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import UsersPage from './+page.svelte'

beforeEach(() => {
  invalidateAllMock.mockReset()
  gotoMock.mockReset()
  updateUserDormancyThresholdMock.mockReset()
  updateMachineKeyDormancyThresholdMock.mockReset()
  pseudonymizeUserMock.mockReset()
  createErasureRequestMock.mockReset()
  changeProjectRoleMock.mockReset()
  deactivateOrgUserMock.mockReset()
  removeOrgUserMock.mockReset()
  sendRecoveryLinkMock.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ownerUser = {
  userId: 'u-owner',
  email: 'dana@example.com',
  displayName: 'Dana Smith',
  orgRole: 'owner',
  status: 'active' as const,
  projects: [],
}

const memberUser = {
  userId: 'u-member',
  email: 'jsmith@example.com',
  displayName: 'J Smith',
  orgRole: 'member',
  status: 'active' as const,
  projects: [],
}

const projectMemberUser = {
  ...memberUser,
  projects: [
    {
      projectId: 'project-1',
      projectName: 'Vault',
      role: 'member' as const,
    },
  ],
}

const deactivatedUser = {
  ...memberUser,
  userId: 'u-deactivated',
  email: 'disabled@example.com',
  displayName: 'Disabled User',
  status: 'deactivated' as const,
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    canManage: true,
    orgRole: 'admin',
    orgId: 'org-1',
    users: [ownerUser, memberUser],
    ...overrides,
  }
}

describe('/settings/users +page.svelte (Story 8.7 AC groups A4/I/J/K)', () => {
  it('renders an honest read-only state and no controls', () => {
    render(UsersPage, { props: { data: baseData({ canManage: false }) } })
    expect(screen.getByText(/only organization owners and admins/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders an explicit empty organization state', () => {
    render(UsersPage, { props: { data: baseData({ users: [] }) } })
    expect(screen.getByText(/no users found/i)).toBeTruthy()
  })

  describe('machine-key dormancy threshold', () => {
    it('saves the selected threshold and blocks duplicate submission while pending', async () => {
      let resolveSave!: (value: { machineKeyDormancyThresholdDays: number }) => void
      updateMachineKeyDormancyThresholdMock.mockReturnValue(
        new Promise((resolve) => {
          resolveSave = resolve
        })
      )
      render(UsersPage, { props: { data: baseData() } })
      await fireEvent.change(screen.getByLabelText(/^dormancy threshold/i), {
        target: { value: '90' },
      })
      const save = screen.getByRole('button', { name: /^save$/i })
      await fireEvent.click(save)
      await fireEvent.click(save)
      expect(updateMachineKeyDormancyThresholdMock).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: /saving/i })).toBeTruthy()
      resolveSave({ machineKeyDormancyThresholdDays: 90 })
      expect(await screen.findByText(/threshold updated to 90 days/i)).toBeTruthy()
    })

    it.each([
      [new ApiClientError(400, { message: 'Invalid threshold' }, 'Invalid threshold'), /invalid/i],
      [new Error('unknown'), /failed to update dormancy threshold/i],
    ])('maps threshold failures', async (failure, expected) => {
      updateMachineKeyDormancyThresholdMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData() } })
      await fireEvent.change(screen.getByLabelText(/^dormancy threshold/i), {
        target: { value: '30' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    })
  })

  describe('AC-I: user dormancy threshold', () => {
    it('AC-I1/I2: renders an unselected "User dormancy alerts" selector; selecting and saving calls updateUserDormancyThreshold', async () => {
      updateUserDormancyThresholdMock.mockResolvedValue({
        orgId: 'org-1',
        userDormancyThresholdDays: 60,
      })

      render(UsersPage, { props: { data: baseData() } })

      const select = screen.getByLabelText(/user dormancy/i) as HTMLSelectElement
      expect(select.value).toBe('')

      await fireEvent.change(select, { target: { value: '60' } })
      await fireEvent.click(screen.getByRole('button', { name: /save user dormancy threshold/i }))

      expect(updateUserDormancyThresholdMock).toHaveBeenCalledWith(expect.anything(), 'org-1', 60)
      expect(await screen.findByText(/threshold updated to 60 days/i)).toBeTruthy()
    })

    it('AC-I3: help text states the change is not retroactive', () => {
      render(UsersPage, { props: { data: baseData() } })
      expect(
        screen.getByText(/does not affect alerts already in your dormant user alerts/i)
      ).toBeTruthy()
    })

    it.each([
      [
        new ApiClientError(400, { message: 'Bad user threshold' }, 'Bad user threshold'),
        /bad user/i,
      ],
      [new Error('unknown'), /failed to update dormancy threshold/i],
    ])('maps user-threshold failures', async (failure, expected) => {
      updateUserDormancyThresholdMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData() } })
      await fireEvent.change(screen.getByLabelText(/user dormancy/i), {
        target: { value: '60' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /save user dormancy threshold/i }))
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    })
  })

  describe('AC-J: pseudonymize', () => {
    it('AC-A4: owner sees "Pseudonymize identity"; admin does not', () => {
      render(UsersPage, { props: { data: baseData({ orgRole: 'owner' }) } })
      expect(
        screen.getAllByRole('button', { name: /pseudonymize identity/i }).length
      ).toBeGreaterThan(0)

      cleanup()
      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      expect(screen.queryByRole('button', { name: /pseudonymize identity/i })).toBeNull()
    })

    it('AC-J1/J3: submit stays disabled until the exact email is typed, then calls pseudonymizeUser', async () => {
      pseudonymizeUserMock.mockResolvedValue({
        userId: memberUser.userId,
        pseudonymized: true,
        pseudonymizedAt: '2026-07-07T00:00:00.000Z',
        alias: 'user_a1b2c3d4',
        otherAffectedOrgCount: 0,
      })

      render(UsersPage, { props: { data: baseData({ orgRole: 'owner' }) } })

      const buttons = screen.getAllByRole('button', { name: /pseudonymize identity/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)

      const confirmButton = screen.getByRole('button', { name: /confirm pseudonymize/i })
      expect((confirmButton as HTMLButtonElement).disabled).toBe(true)

      const input = screen.getByLabelText(/type the exact email/i)
      await fireEvent.input(input, { target: { value: memberUser.email } })
      expect((confirmButton as HTMLButtonElement).disabled).toBe(false)

      await fireEvent.click(confirmButton)

      expect(pseudonymizeUserMock).toHaveBeenCalledWith(expect.anything(), memberUser.userId)
      expect(await screen.findByText(/no other organizations affected/i)).toBeTruthy()
    })

    it('AC-J2: surfaces a nonzero otherAffectedOrgCount plainly', async () => {
      pseudonymizeUserMock.mockResolvedValue({
        userId: memberUser.userId,
        pseudonymized: true,
        pseudonymizedAt: '2026-07-07T00:00:00.000Z',
        alias: 'user_e5f6g7h8',
        otherAffectedOrgCount: 2,
      })

      render(UsersPage, { props: { data: baseData({ orgRole: 'owner' }) } })
      const buttons = screen.getAllByRole('button', { name: /pseudonymize identity/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      await fireEvent.input(screen.getByLabelText(/type the exact email/i), {
        target: { value: memberUser.email },
      })
      await fireEvent.click(screen.getByRole('button', { name: /confirm pseudonymize/i }))

      expect(await screen.findByText(/2 other organization/i)).toBeTruthy()
    })

    it.each([
      [
        new ApiClientError(409, { message: 'Cannot pseudonymize' }, 'Cannot pseudonymize'),
        /cannot/i,
      ],
      [new Error('unknown'), /failed to pseudonymize identity/i],
    ])('maps pseudonymization failures and permits cancellation', async (failure, expected) => {
      pseudonymizeUserMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData({ orgRole: 'owner' }) } })
      const buttons = screen.getAllByRole('button', { name: /pseudonymize identity/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      await fireEvent.input(screen.getByLabelText(/type the exact email/i), {
        target: { value: memberUser.email },
      })
      await fireEvent.click(screen.getByRole('button', { name: /confirm pseudonymize/i }))
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
      await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
      expect(screen.queryByLabelText(/type the exact email/i)).toBeNull()
    })
  })

  describe('AC-K: request erasure', () => {
    it('AC-A4: admin+ sees "Request erasure"', () => {
      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      expect(screen.getAllByRole('button', { name: /request erasure/i }).length).toBeGreaterThan(0)
    })

    it('AC-K1: submits reason/requestedBy and navigates to the new request page on 201', async () => {
      createErasureRequestMock.mockResolvedValue({
        requestId: 'req-1',
        status: 'pending',
        piiInventory: { tables: [] },
      })

      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      const buttons = screen.getAllByRole('button', { name: /request erasure/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)

      await fireEvent.input(screen.getByLabelText(/reason/i), {
        target: { value: 'Contractor offboarding' },
      })
      await fireEvent.input(screen.getByLabelText(/requested by/i), {
        target: { value: 'Data Subject via support ticket #4021' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /submit request/i }))

      expect(createErasureRequestMock).toHaveBeenCalledWith(expect.anything(), memberUser.userId, {
        reason: 'Contractor offboarding',
        requestedBy: 'Data Subject via support ticket #4021',
      })
      expect(gotoMock).toHaveBeenCalledWith(`/settings/users/${memberUser.userId}/erasure/req-1`)
    })

    it('AC-K3: a 409 already-pending response navigates to the existing request', async () => {
      createErasureRequestMock.mockRejectedValue(
        new ApiClientError(
          409,
          {
            code: 'erasure_request_already_pending',
            message: 'pending',
            requestId: 'req-existing',
            piiInventory: { tables: [] },
          },
          'pending'
        )
      )

      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      const buttons = screen.getAllByRole('button', { name: /request erasure/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      await fireEvent.input(screen.getByLabelText(/reason/i), { target: { value: 'x' } })
      await fireEvent.input(screen.getByLabelText(/requested by/i), { target: { value: 'y' } })
      await fireEvent.click(screen.getByRole('button', { name: /submit request/i }))

      expect(gotoMock).toHaveBeenCalledWith(
        `/settings/users/${memberUser.userId}/erasure/req-existing`
      )
    })

    it('AC-K4: a 410 already-erased response navigates to the completed request', async () => {
      createErasureRequestMock.mockRejectedValue(
        new ApiClientError(
          410,
          {
            code: 'user_already_erased',
            message: 'erased',
            requestId: 'req-done',
            completedAt: '2026-06-01T00:00:00.000Z',
          },
          'erased'
        )
      )

      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      const buttons = screen.getAllByRole('button', { name: /request erasure/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      await fireEvent.input(screen.getByLabelText(/reason/i), { target: { value: 'x' } })
      await fireEvent.input(screen.getByLabelText(/requested by/i), { target: { value: 'y' } })
      await fireEvent.click(screen.getByRole('button', { name: /submit request/i }))

      expect(gotoMock).toHaveBeenCalledWith(`/settings/users/${memberUser.userId}/erasure/req-done`)
    })

    it('AC-K2: a 404 shows a friendly message without crashing', async () => {
      createErasureRequestMock.mockRejectedValue(
        new ApiClientError(404, { message: 'User not found' }, 'User not found')
      )

      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      const buttons = screen.getAllByRole('button', { name: /request erasure/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      await fireEvent.input(screen.getByLabelText(/reason/i), { target: { value: 'x' } })
      await fireEvent.input(screen.getByLabelText(/requested by/i), { target: { value: 'y' } })
      await fireEvent.click(screen.getByRole('button', { name: /submit request/i }))

      expect(await screen.findByText('User not found')).toBeTruthy()
      expect(gotoMock).not.toHaveBeenCalled()
    })

    it.each([409, 410])(
      'shows an error when a %i erasure response omits requestId',
      async (status) => {
        createErasureRequestMock.mockRejectedValue(
          new ApiClientError(status, { message: 'Missing request id' }, 'Missing request id')
        )
        render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
        const buttons = screen.getAllByRole('button', { name: /request erasure/i })
        await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
        await fireEvent.input(screen.getByLabelText(/reason/i), { target: { value: 'x' } })
        await fireEvent.input(screen.getByLabelText(/requested by/i), { target: { value: 'y' } })
        await fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
        expect(await screen.findByText(/missing request id/i)).toBeTruthy()
        expect(gotoMock).not.toHaveBeenCalled()
      }
    )

    it('maps an unknown erasure failure and closes on cancellation', async () => {
      createErasureRequestMock.mockRejectedValue({ reason: 'unknown' })
      render(UsersPage, { props: { data: baseData({ orgRole: 'admin' }) } })
      const buttons = screen.getAllByRole('button', { name: /request erasure/i })
      await fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
      await fireEvent.input(screen.getByLabelText(/reason/i), { target: { value: 'x' } })
      await fireEvent.input(screen.getByLabelText(/requested by/i), { target: { value: 'y' } })
      await fireEvent.click(screen.getByRole('button', { name: /submit request/i }))
      expect(await screen.findByText(/failed to create erasure request/i)).toBeTruthy()
      await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
      expect(screen.queryByLabelText(/requested by/i)).toBeNull()
    })
  })

  describe('organization member actions', () => {
    it('renders active/deactivated rows and changes a project role once while busy', async () => {
      let resolveChange!: () => void
      changeProjectRoleMock.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveChange = resolve
        })
      )
      render(UsersPage, {
        props: { data: baseData({ users: [projectMemberUser, deactivatedUser] }) },
      })
      expect(screen.getByText('Deactivated')).toBeTruthy()
      expect(screen.getAllByRole('button', { name: /deactivate account/i })).toHaveLength(1)
      const select = screen.getByLabelText(/role for jsmith@example.com in vault/i)
      await fireEvent.change(select, { target: { value: 'viewer' } })
      await fireEvent.change(select, { target: { value: 'admin' } })
      expect(changeProjectRoleMock).toHaveBeenCalledTimes(1)
      resolveChange()
      await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalledTimes(1))
    })

    it.each([
      [new ApiClientError(403, { message: 'Role denied' }, 'Role denied'), /role denied/i],
      [new Error('unknown'), /failed to change role/i],
    ])('maps project-role failures', async (failure, expected) => {
      changeProjectRoleMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData({ users: [projectMemberUser] }) } })
      await fireEvent.change(screen.getByLabelText(/role for jsmith@example.com in vault/i), {
        target: { value: 'viewer' },
      })
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    })

    it('cancels deactivation without mutation', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      await fireEvent.click(screen.getByRole('button', { name: /deactivate account/i }))
      expect(deactivateOrgUserMock).not.toHaveBeenCalled()
    })

    it('deactivates once while pending and invalidates', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      let resolveDeactivate!: () => void
      deactivateOrgUserMock.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveDeactivate = resolve
        })
      )
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      const button = screen.getByRole('button', { name: /deactivate account/i })
      await fireEvent.click(button)
      await fireEvent.click(button)
      expect(deactivateOrgUserMock).toHaveBeenCalledTimes(1)
      resolveDeactivate()
      await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalledTimes(1))
    })

    it.each([
      [
        new ApiClientError(409, { code: 'already_deactivated', message: 'already' }, 'already'),
        /already deactivated/i,
      ],
      [new ApiClientError(403, { message: 'Deactivate denied' }, 'Deactivate denied'), /denied/i],
      [new Error('unknown'), /failed to deactivate account/i],
    ])('maps deactivation failures', async (failure, expected) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      deactivateOrgUserMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      await fireEvent.click(screen.getByRole('button', { name: /deactivate account/i }))
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    })

    it('cancels removal and recovery without API calls', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      await fireEvent.click(screen.getByRole('button', { name: /remove from organization/i }))
      await fireEvent.click(screen.getByRole('button', { name: /send recovery link/i }))
      expect(removeOrgUserMock).not.toHaveBeenCalled()
      expect(sendRecoveryLinkMock).not.toHaveBeenCalled()
    })

    it('removes a confirmed user and sends a confirmed recovery link', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      removeOrgUserMock.mockResolvedValue({})
      sendRecoveryLinkMock.mockResolvedValue({})
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      await fireEvent.click(screen.getByRole('button', { name: /remove from organization/i }))
      expect(removeOrgUserMock).toHaveBeenCalledWith(expect.anything(), memberUser.userId)
      await fireEvent.click(screen.getByRole('button', { name: /send recovery link/i }))
      expect(sendRecoveryLinkMock).toHaveBeenCalledWith(expect.anything(), memberUser.userId)
      expect(await screen.findByText(/recovery link sent/i)).toBeTruthy()
    })

    it.each([
      [
        new ApiClientError(
          409,
          {
            code: 'sole_owner_of_projects',
            message: 'blocked',
            projects: [{ projectName: 'One' }, { projectName: 'Two' }],
          },
          'blocked'
        ),
        /owns 2 projects.*one, two/i,
      ],
      [
        new ApiClientError(409, { code: 'last_org_owner', message: 'last' }, 'last'),
        /sole owner of the organization/i,
      ],
      [new ApiClientError(403, { message: 'Remove denied' }, 'Remove denied'), /remove denied/i],
      [new Error('unknown'), /failed to remove user/i],
    ])('maps organization-removal failures', async (failure, expected) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      removeOrgUserMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      await fireEvent.click(screen.getByRole('button', { name: /remove from organization/i }))
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    })

    it.each([
      [new ApiClientError(403, { message: 'Recovery denied' }, 'Recovery denied'), /denied/i],
      [new Error('unknown'), /failed to send recovery link/i],
    ])('maps recovery-link failures', async (failure, expected) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      sendRecoveryLinkMock.mockRejectedValue(failure)
      render(UsersPage, { props: { data: baseData({ users: [memberUser] }) } })
      await fireEvent.click(screen.getByRole('button', { name: /send recovery link/i }))
      expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    })
  })
})
