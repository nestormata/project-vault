import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import type { AuthUser } from '$lib/api/auth.js'
import { testAuthUser } from '$lib/test/page-data.js'

const listMock = vi.hoisted(() => vi.fn())
const startMock = vi.hoisted(() => vi.fn())
const completeMock = vi.hoisted(() => vi.fn())
const renameMock = vi.hoisted(() => vi.fn())
const deleteMock = vi.hoisted(() => vi.fn())
const browserStartMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/api/auth.js')>('$lib/api/auth.js')
  return {
    ...actual,
    listWebauthnCredentials: listMock,
    startWebauthnRegistration: startMock,
    completeWebauthnRegistration: completeMock,
    renameWebauthnCredential: renameMock,
    deleteWebauthnCredential: deleteMock,
  }
})

vi.mock('./webauthn-browser.js', () => ({
  startHardwareKeyRegistration: browserStartMock,
}))

import HardwareKeysPanel from './HardwareKeysPanel.svelte'

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return testAuthUser({
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    orgRole: 'owner',
    mfaEnrolled: true,
    mfaEnrolledAt: '2026-06-01T00:00:00.000Z',
    remainingRecoveryCodesCount: 5,
    ...overrides,
  })
}

const listed = {
  credentials: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Desk',
      createdAt: '2026-11-15T00:00:00.000Z',
      lastUsedAt: null,
      signCount: 0,
    },
  ],
}

function deskCredential() {
  const row = listed.credentials[0]
  if (!row) throw new Error('test fixture missing desk credential')
  return row
}

describe('HardwareKeysPanel', () => {
  beforeEach(() => {
    listMock.mockReset()
    startMock.mockReset()
    completeMock.mockReset()
    renameMock.mockReset()
    deleteMock.mockReset()
    browserStartMock.mockReset()
    listMock.mockResolvedValue({ credentials: [] })
  })
  afterEach(() => cleanup())

  it('tells an unenrolled user that keys wait on TOTP and never offers registration', () => {
    render(HardwareKeysPanel, { props: { initialUser: user({ mfaEnrolled: false }) } })
    expect(screen.getByText(/become available once TOTP is enrolled/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /register hardware key/i })).toBeNull()
    expect(listMock).not.toHaveBeenCalled()
  })

  it('states that the key secret cannot be copied, exported, or backed up', async () => {
    render(HardwareKeysPanel, { props: { initialUser: user() } })
    expect(await screen.findByText(/cannot be copied, exported, or backed up/i)).toBeTruthy()
    expect(screen.getByText(/use a recovery code from this page/i)).toBeTruthy()
    expect(screen.queryByText(/copy this secret|export the key|backup the private/i)).toBeNull()
  })

  it('registers a named key through options then attestation', async () => {
    startMock.mockResolvedValue({
      challengeId: '22222222-2222-4222-8222-222222222222',
      options: { challenge: 'abc' },
    })
    browserStartMock.mockResolvedValue({
      id: 'att',
      rawId: 'att',
      type: 'public-key',
      response: { clientDataJSON: 'e30', attestationObject: 'e30' },
    })
    completeMock.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Travel',
      createdAt: '2026-11-15T00:00:00.000Z',
    })
    listMock.mockResolvedValueOnce({ credentials: [] }).mockResolvedValueOnce({
      credentials: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Travel',
          createdAt: '2026-11-15T00:00:00.000Z',
          lastUsedAt: null,
          signCount: 0,
        },
      ],
    })
    render(HardwareKeysPanel, { props: { initialUser: user() } })
    const nameInput = await screen.findByLabelText(/key name/i)
    await fireEvent.input(nameInput, { target: { value: 'Travel' } })
    await fireEvent.click(screen.getByRole('button', { name: /register hardware key/i }))
    expect(startMock).toHaveBeenCalledWith(fetch)
    expect(browserStartMock).toHaveBeenCalled()
    expect(completeMock).toHaveBeenCalledWith(
      fetch,
      expect.objectContaining({
        name: 'Travel',
        challengeId: '22222222-2222-4222-8222-222222222222',
      })
    )
    expect(await screen.findByText('Travel')).toBeTruthy()
  })

  it('renames and removes a listed key', async () => {
    const desk = deskCredential()
    listMock.mockResolvedValue(listed)
    renameMock.mockResolvedValue({ id: desk.id, name: 'Office' })
    deleteMock.mockResolvedValue({ id: desk.id })
    render(HardwareKeysPanel, { props: { initialUser: user() } })
    expect(await screen.findByText('Desk')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /rename/i }))
    const renameInput = screen.getAllByLabelText(/key name/i)[0]
    if (!renameInput) throw new Error('rename input missing')
    await fireEvent.input(renameInput, {
      target: { value: 'Office' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save name/i }))
    expect(renameMock).toHaveBeenCalledWith(fetch, desk.id, 'Office')

    listMock.mockResolvedValue(listed)
    await fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm remove/i }))
    expect(deleteMock).toHaveBeenCalledWith(fetch, desk.id)
  })

  it('shows the last-factor API message when remove is refused', async () => {
    listMock.mockResolvedValue(listed)
    deleteMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'last_second_factor_required',
          message:
            'Cannot remove the last remaining second factor while Owner and Admin MFA is required.',
        },
        'Cannot remove the last remaining second factor while Owner and Admin MFA is required.'
      )
    )
    render(HardwareKeysPanel, { props: { initialUser: user() } })
    await fireEvent.click(await screen.findByRole('button', { name: /^remove$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm remove/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Owner and Admin MFA/)
  })
})
