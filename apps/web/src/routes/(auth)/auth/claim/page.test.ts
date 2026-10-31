import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const claimHandoffMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$lib/api/auth.js', () => ({
  claimHandoff: claimHandoffMock,
  getCurrentUser: getCurrentUserMock,
  verifyMfaLogin: verifyMfaLoginMock,
}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))

import ClaimPage from './+page.svelte'

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJub25jZSI6Im4ifQ.c2ln'
const ERROR_HEADING = "Sign-in couldn't be completed"
const GENERIC_REJECTION = 'Sign-in could not be verified. Please start again.'

function visit(hash: string): void {
  window.history.replaceState(null, '', `/auth/claim${hash}`)
}

function heading(): string | null | undefined {
  return screen.queryByRole('heading', { level: 1 })?.textContent?.trim()
}

describe('/auth/claim +page.svelte (Story 73.1)', () => {
  beforeEach(() => {
    document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
    claimHandoffMock.mockReset()
    getCurrentUserMock.mockReset()
    verifyMfaLoginMock.mockReset()
    gotoMock.mockClear()
  })
  afterEach(() => cleanup())

  it('posts the fragment token, drops the fragment from history first, and lands on /dashboard with no click', async () => {
    visit(`#${TOKEN}`)
    let hashWhenPosted: string | undefined
    claimHandoffMock.mockImplementation(() => {
      hashWhenPosted = window.location.hash
      return Promise.resolve({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(ClaimPage)

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
    expect(claimHandoffMock).toHaveBeenCalledWith(expect.any(Function), TOKEN)
    expect(hashWhenPosted).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(getCurrentUserMock).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull()
  })

  it('shows only an sr-only working status and a noscript message while the claim is in flight', () => {
    visit(`#${TOKEN}`)
    claimHandoffMock.mockReturnValue(new Promise(() => undefined))

    const { container } = render(ClaimPage)

    const status = screen.getByRole('status')
    expect(status.textContent?.trim()).toBe('Signing you in')
    expect(status.className).toContain('sr-only')
    expect(container.querySelector('noscript')).not.toBeNull()
    expect(heading()).toBeUndefined()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows the error state with no request when the fragment is empty', async () => {
    visit('')

    render(ClaimPage)

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', GENERIC_REJECTION)
    expect(heading()).toBe(ERROR_HEADING)
    expect(claimHandoffMock).not.toHaveBeenCalled()
  })

  it('shows the generic rejection, the return guidance and no retry control on a 401', async () => {
    visit(`#${TOKEN}`)
    claimHandoffMock.mockRejectedValue(
      new ApiClientError(401, { code: 'handoff_rejected' }, 'raw server text')
    )

    render(ClaimPage)

    expect((await screen.findByRole('alert')).textContent?.trim()).toBe(GENERIC_REJECTION)
    expect(heading()).toBe(ERROR_HEADING)
    expect(screen.getByText(/start signing in again/)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByText('raw server text')).toBeNull()
  })

  it.each([
    ['a 503', () => new ApiClientError(503, null, 'down')],
    ['a network failure', () => new TypeError('Failed to fetch')],
  ])('shows the error state with no retry control on %s', async (_label, error) => {
    visit(`#${TOKEN}`)
    claimHandoffMock.mockRejectedValue(error())

    render(ClaimPage)

    expect((await screen.findByRole('alert')).textContent?.trim()).toBe(
      'Login failed, please try again.'
    )
    expect(heading()).toBe(ERROR_HEADING)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows the MFA form on an mfaRequired answer and signs in once it verifies', async () => {
    visit(`#${TOKEN}`)
    claimHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

    render(ClaimPage)

    const code = await screen.findByLabelText(/authenticator code/i)
    expect(heading()).toBe('Finish signing in')
    verifyMfaLoginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: 'x' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    await fireEvent.input(code, { target: { value: '123456' } })
    await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  it('an expired MFA step ends in the error state', async () => {
    visit(`#${TOKEN}`)
    claimHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
    verifyMfaLoginMock.mockRejectedValue(
      new ApiClientError(401, { code: 'mfa_token_expired' }, 'expired')
    )

    render(ClaimPage)
    await fireEvent.input(await screen.findByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))

    await waitFor(() => expect(heading()).toBe(ERROR_HEADING))
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Your login step expired. Please sign in again.'
    )
  })

  it('links the return guidance only to the configured origin', async () => {
    visit('')

    render(ClaimPage, { props: { data: { centralizeMeOrigin: 'https://app.example' } } })

    const link = await screen.findByRole('link', { name: 'Return to CentralizeMe' })
    expect(link.getAttribute('href')).toBe('https://app.example')
    expect(link.getAttribute('rel')).toBe('external noopener noreferrer')
  })
})
