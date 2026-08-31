import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const confirmHandoffMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const pageMock = vi.hoisted(() => ({ url: new URL('http://localhost/handoff') }))

vi.mock('$lib/api/auth.js', () => ({
  confirmHandoff: confirmHandoffMock,
  getCurrentUser: getCurrentUserMock,
  verifyMfaLogin: verifyMfaLoginMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import HandoffPage from './+page.svelte'

const VALID_PENDING_ID = 'abc123_XYZ-789'

function setUrl(query: string) {
  pageMock.url = new URL(`http://localhost/handoff${query}`)
}

function fullQuery({
  pendingId = VALID_PENDING_ID,
  organizationName = 'Acme%20Corp',
  accountLabel = 'alex%40acme.com',
}: {
  pendingId?: string | null
  organizationName?: string | null
  accountLabel?: string | null
} = {}) {
  const parts: string[] = []
  if (pendingId !== null) parts.push(`pendingId=${pendingId}`)
  if (organizationName !== null) parts.push(`organizationName=${organizationName}`)
  if (accountLabel !== null) parts.push(`accountLabel=${accountLabel}`)
  return `?${parts.join('&')}`
}

describe('/handoff +page.svelte', () => {
  beforeEach(() => {
    document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
    setUrl(fullQuery())
    confirmHandoffMock.mockReset()
    getCurrentUserMock.mockReset()
    verifyMfaLoginMock.mockReset()
    gotoMock.mockClear()
  })
  afterEach(() => cleanup())

  // AC1.1
  it('renders the resolved account/org and a Confirm button, with no backend call before clicking', () => {
    render(HandoffPage)

    expect(screen.getByText('Sign in to Project Vault as alex@acme.com in Acme Corp?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm sign-in' })).toBeTruthy()
    expect(confirmHandoffMock).not.toHaveBeenCalled()
  })

  // AC1.2
  it('renders the neutral error state with no Confirm button when pendingId is missing', () => {
    setUrl(fullQuery({ pendingId: null }))
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  it('renders the neutral error state when pendingId is malformed', () => {
    setUrl(fullQuery({ pendingId: 'has a space' }))
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  it('renders the neutral error state when pendingId is an empty string', () => {
    setUrl(fullQuery({ pendingId: '' }))
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
  })

  // AC1.3
  it('renders HTML-significant characters in org/account names as literal, inert text', () => {
    setUrl(
      fullQuery({
        organizationName: encodeURIComponent('"><script>alert(1)</script>'),
        accountLabel: encodeURIComponent('<b>alex</b>'),
      })
    )
    render(HandoffPage)

    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent ===
          'Sign in to Project Vault as <b>alex</b> in "><script>alert(1)</script>?'
      )
    ).toBeTruthy()
  })

  // AC1.4
  it('renders the neutral error state on a direct navigation with no query params at all', () => {
    setUrl('')
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  // AC1.5
  it('falls back to a generic phrase instead of the literal string "null"', () => {
    setUrl(fullQuery({ organizationName: 'null', accountLabel: 'null' }))
    render(HandoffPage)

    expect(
      screen.getByText('Sign in to Project Vault as your account in your organization?')
    ).toBeTruthy()
    expect(screen.queryByText(/null/)).toBeNull()
  })

  it('falls back to a generic phrase when org/account names are absent but pendingId is valid', () => {
    setUrl(fullQuery({ organizationName: null, accountLabel: null }))
    render(HandoffPage)

    expect(
      screen.getByText('Sign in to Project Vault as your account in your organization?')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm sign-in' })).toBeTruthy()
  })

  // AC2.5
  it('completes the session and navigates to /dashboard on immediate success', async () => {
    confirmHandoffMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
    expect(getCurrentUserMock).toHaveBeenCalled()
  })

  // AC2.6
  it('renders MfaLoginForm unmodified when a 200 mfaRequired response is returned', async () => {
    confirmHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByLabelText(/authenticator code/i)).toBeTruthy()

    verifyMfaLoginMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  // AC2.7
  it('renders the generic rejection message with no retry button on a 401', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(
        401,
        { code: 'handoff_rejected', message: 'Sign-in could not be verified. Please start again.' },
        'Sign-in could not be verified. Please start again.'
      )
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Sign-in could not be verified. Please start again.'
    )
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
    expect(screen.getByText(/return to centralizeme/i)).toBeTruthy()
  })

  it('shows the shared generic-rejection copy even if the 401 body carries a different message', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(401, { message: 'something else' }, 'something else')
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Sign-in could not be verified. Please start again.'
    )
  })

  // AC2.8
  it('renders a distinct message on a 503 login_failed response', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(503, { code: 'login_failed' }, 'Login failed, please try again')
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toBe('Sign-in could not be verified. Please start again.')
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  // AC2.9
  it('ignores a second click while a confirm request is already in flight', async () => {
    let resolveConfirm: (value: unknown) => void = () => {}
    confirmHandoffMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirm = resolve
      })
    )

    render(HandoffPage)
    const button = screen.getByRole('button', { name: 'Confirm sign-in' })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(confirmHandoffMock).toHaveBeenCalledTimes(1)
    resolveConfirm({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  // AC2.10
  it('shows a network-error state distinct from 401/503 and re-enables the Confirm button', async () => {
    confirmHandoffMock.mockRejectedValue(new TypeError('Failed to fetch'))

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Something went wrong. Please try again.')
    const retryButton = screen.getByRole('button', { name: 'Confirm sign-in' }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(false)
  })

  // AC5.18
  it('rejects generically for a valid-shaped but cookie-less confirm attempt (no session minted)', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(
        401,
        { code: 'handoff_rejected', message: 'Sign-in could not be verified. Please start again.' },
        'x'
      )
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Sign-in could not be verified. Please start again.'
    )
    expect(gotoMock).not.toHaveBeenCalled()
  })

  // AC5.19
  it('never reads a next/returnTo query parameter', async () => {
    setUrl(`${fullQuery()}&next=/some-other-page`)
    confirmHandoffMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })
})
