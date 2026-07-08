import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const gotoMock = vi.hoisted(() => vi.fn())
const updateUserDormancyThresholdMock = vi.hoisted(() => vi.fn())
const updateMachineKeyDormancyThresholdMock = vi.hoisted(() => vi.fn())
const pseudonymizeUserMock = vi.hoisted(() => vi.fn())
const createErasureRequestMock = vi.hoisted(() => vi.fn())

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
  changeProjectRole: vi.fn(),
  deactivateOrgUser: vi.fn(),
  removeOrgUser: vi.fn(),
  sendRecoveryLink: vi.fn(),
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
})

afterEach(() => cleanup())

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
  })
})
