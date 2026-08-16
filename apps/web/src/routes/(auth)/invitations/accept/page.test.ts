import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const peekInvitationMock = vi.hoisted(() => vi.fn())
const acceptInvitationMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const lookupSsoDomainMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const setPreAuthThemeMock = vi.hoisted(() => vi.fn())
const writePreAuthThemeCacheMock = vi.hoisted(() => vi.fn())
const pageMock = vi.hoisted(() => ({
  url: new URL('http://localhost/invitations/accept?token=tok-1'),
}))

vi.mock('$lib/api/invitations.js', () => ({
  peekInvitation: peekInvitationMock,
  acceptInvitation: acceptInvitationMock,
}))

vi.mock('$lib/api/auth.js', () => ({
  getCurrentUser: getCurrentUserMock,
  lookupSsoDomain: lookupSsoDomainMock,
}))

vi.mock('$lib/state/theme.svelte.js', () => ({
  setPreAuthTheme: setPreAuthThemeMock,
  writePreAuthThemeCache: writePreAuthThemeCacheMock,
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
    lookupSsoDomainMock.mockReset()
    lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
    gotoMock.mockClear()
    setPreAuthThemeMock.mockReset()
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

  describe('Story 23.2 AC-6c: external sign-in state for an account-less invitee under exclusion', () => {
    it('renders the honest external-sign-in state instead of redirecting to /register when nativeLoginEnabled is false', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'new@example.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
        nativeLoginEnabled: false,
      })

      render(InvitationsAcceptPage)

      expect(await screen.findByText(/external sign-in required/i)).toBeTruthy()
      expect(
        screen.getByText(/sign in with your organization account to accept this invitation/i)
      ).toBeTruthy()
      expect(gotoMock).not.toHaveBeenCalled()
    })

    it('the external-sign-in link points into /login with a next param that returns to this invitation', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'new@example.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
        nativeLoginEnabled: false,
      })

      render(InvitationsAcceptPage)

      const link = await screen.findByRole('link', {
        name: /sign in with your organization account/i,
      })
      expect(link.getAttribute('href')).toBe('/login?next=%2Finvitations%2Faccept%3Ftoken%3Dtok-1')
    })

    it('never a dead end: does not show a "create your account" link into the gated /register form', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'new@example.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
        nativeLoginEnabled: false,
      })

      render(InvitationsAcceptPage)

      await screen.findByText(/external sign-in required/i)
      expect(screen.queryByText(/create your account/i)).toBeNull()
    })

    it('AC-16 regression: still redirects to /register, byte-identical, when nativeLoginEnabled is true', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'new@example.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
        nativeLoginEnabled: true,
      })

      render(InvitationsAcceptPage)

      await waitFor(() =>
        expect(gotoMock).toHaveBeenCalledWith(
          '/register?invitationToken=tok-1&email=new%40example.com'
        )
      )
    })
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

  // Story 16.5 AC-3: resolve org branding as soon as the invitation peek returns an email,
  // fire-and-forget, before either redirect branch.
  describe('pre-auth theme resolution (AC-3)', () => {
    it('applies the resolved theme before/alongside the redirect to /register (no account yet)', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'alex@acme.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
      })
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })

      render(InvitationsAcceptPage)

      await waitFor(() => expect(lookupSsoDomainMock).toHaveBeenCalledWith(fetch, 'alex@acme.com'))
      await waitFor(() =>
        expect(setPreAuthThemeMock).toHaveBeenCalledWith(
          'acme-brand',
          '[data-theme="acme-brand"] {}'
        )
      )
      await waitFor(() =>
        expect(gotoMock).toHaveBeenCalledWith(
          '/register?invitationToken=tok-1&email=alex%40acme.com'
        )
      )
    })

    it('applies the resolved theme before redirecting to /login (account exists, not authenticated)', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'existing@acme.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: true,
      })
      getCurrentUserMock.mockRejectedValue(new ApiClientError(401, null, 'unauthorized'))
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })

      render(InvitationsAcceptPage)

      await waitFor(() =>
        expect(lookupSsoDomainMock).toHaveBeenCalledWith(fetch, 'existing@acme.com')
      )
      await waitFor(() =>
        expect(setPreAuthThemeMock).toHaveBeenCalledWith(
          'acme-brand',
          '[data-theme="acme-brand"] {}'
        )
      )
      await waitFor(() =>
        expect(gotoMock).toHaveBeenCalledWith('/login?next=%2Finvitations%2Faccept%3Ftoken%3Dtok-1')
      )
    })

    it('redirect proceeds normally, base theme, when the theme lookup itself fails', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'alex@acme.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
      })
      lookupSsoDomainMock.mockRejectedValue(new TypeError('Failed to fetch'))

      render(InvitationsAcceptPage)

      await waitFor(() =>
        expect(gotoMock).toHaveBeenCalledWith(
          '/register?invitationToken=tok-1&email=alex%40acme.com'
        )
      )
      // AC-3's stated fail-open equivalence: either setPreAuthTheme(null, null) is called, or it
      // is never called at all — both leave the rune at its base-theme default. Assert the
      // concrete behavior this implementation chooses (an explicit reset), rather than asserting
      // "not called" and being coupled to the other, equally-valid alternative.
      await waitFor(() => expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null))
    })

    it('never attempts a theme lookup when peekInvitation itself fails (invalid token)', async () => {
      peekInvitationMock.mockRejectedValue(new ApiClientError(404, { message: 'nf' }, 'nf'))

      render(InvitationsAcceptPage)

      await screen.findByText(/invitation not available/i)
      expect(lookupSsoDomainMock).not.toHaveBeenCalled()
    })

    it('never delays the redirect: a slow/never-resolving theme lookup does not block goto() (Pre-Mortem #1)', async () => {
      peekInvitationMock.mockResolvedValue({
        email: 'alex@acme.com',
        projectName: 'Payments',
        role: 'member',
        accountExists: false,
      })
      // Never resolves within this test's lifetime.
      lookupSsoDomainMock.mockReturnValue(new Promise(() => {}))

      render(InvitationsAcceptPage)

      await waitFor(() =>
        expect(gotoMock).toHaveBeenCalledWith(
          '/register?invitationToken=tok-1&email=alex%40acme.com'
        )
      )
    })
  })
})
