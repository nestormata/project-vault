import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const peekInvitationMock = vi.hoisted(() => vi.fn())
const acceptInvitationMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const pageMock = vi.hoisted(() => ({
  url: new URL('http://localhost/invitations/accept?token=tok-1'),
}))

vi.mock('$lib/api/invitations.js', () => ({
  peekInvitation: peekInvitationMock,
  acceptInvitation: acceptInvitationMock,
}))

vi.mock('$lib/api/auth.js', () => ({
  getCurrentUser: getCurrentUserMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import InvitationsAcceptPage from './+page.svelte'

describe('/invitations/accept +page.svelte', () => {
  beforeEach(() => {
    peekInvitationMock.mockReset()
    acceptInvitationMock.mockReset()
    getCurrentUserMock.mockReset()
    gotoMock.mockClear()
    pageMock.url = new URL('http://localhost/invitations/accept?token=tok-1')
  })
  afterEach(() => cleanup())

  it('shows the invalid state when no token is present in the URL', async () => {
    pageMock.url = new URL('http://localhost/invitations/accept')

    render(InvitationsAcceptPage)

    expect(await screen.findByText(/invitation not available/i)).toBeTruthy()
    expect(screen.getByText(/this invitation link is missing a token/i)).toBeTruthy()
    expect(peekInvitationMock).not.toHaveBeenCalled()
  })

  it('shows the invalid state with a specific message when the peek 404s (ApiClientError)', async () => {
    peekInvitationMock.mockRejectedValue(new ApiClientError(404, { message: 'nf' }, 'nf'))

    render(InvitationsAcceptPage)

    expect(await screen.findByText(/invitation not available/i)).toBeTruthy()
    expect(screen.getByText(/this invitation link is no longer valid/i)).toBeTruthy()
  })

  it('shows a generic invalid message when the peek fails with a non-ApiClientError', async () => {
    peekInvitationMock.mockRejectedValue(new Error('network down'))

    render(InvitationsAcceptPage)

    expect(await screen.findByText(/invitation not available/i)).toBeTruthy()
    expect(screen.getByText(/something went wrong loading this invitation/i)).toBeTruthy()
  })

  it('redirects to register with the invitation token and email when no account exists yet', async () => {
    peekInvitationMock.mockResolvedValue({
      email: 'new@example.com',
      projectName: 'Payments',
      role: 'member',
      accountExists: false,
    })

    render(InvitationsAcceptPage)

    await waitFor(() =>
      expect(gotoMock).toHaveBeenCalledWith(
        '/register?invitationToken=tok-1&email=new%40example.com'
      )
    )
    expect(getCurrentUserMock).not.toHaveBeenCalled()
  })

  it('redirects to login (preserving a return path) when an account exists but the caller is not authenticated', async () => {
    peekInvitationMock.mockResolvedValue({
      email: 'existing@example.com',
      projectName: 'Payments',
      role: 'member',
      accountExists: true,
    })
    getCurrentUserMock.mockRejectedValue(new ApiClientError(401, null, 'unauthorized'))

    render(InvitationsAcceptPage)

    await waitFor(() =>
      expect(gotoMock).toHaveBeenCalledWith('/login?next=%2Finvitations%2Faccept%3Ftoken%3Dtok-1')
    )
    expect(acceptInvitationMock).not.toHaveBeenCalled()
  })

  it('accepts the invitation and redirects into the project when the caller is already signed in', async () => {
    peekInvitationMock.mockResolvedValue({
      email: 'existing@example.com',
      projectName: 'Payments',
      role: 'member',
      accountExists: true,
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    acceptInvitationMock.mockResolvedValue({
      projectId: 'proj-1',
      projectName: 'Payments',
      role: 'member',
    })

    render(InvitationsAcceptPage)

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects/proj-1'))
    expect(acceptInvitationMock).toHaveBeenCalledWith(fetch, 'tok-1')
  })

  it('shows the error state when accepting the invitation fails', async () => {
    peekInvitationMock.mockResolvedValue({
      email: 'existing@example.com',
      projectName: 'Payments',
      role: 'member',
      accountExists: true,
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    acceptInvitationMock.mockRejectedValue(new Error('boom'))

    render(InvitationsAcceptPage)

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy()
    expect(
      screen.getByText(/we couldn't accept this invitation\. please try again\./i)
    ).toBeTruthy()
  })
})
