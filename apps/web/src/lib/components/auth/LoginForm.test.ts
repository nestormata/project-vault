import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const loginMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$lib/api/auth.js', () => ({
  login: loginMock,
  getCurrentUser: getCurrentUserMock,
  verifyMfaLogin: verifyMfaLoginMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

import LoginForm from './LoginForm.svelte'

async function fillAndSubmit(email = 'alex@example.com', password = 'correcthorsebattery') {
  await fireEvent.input(screen.getByLabelText(/email/i), { target: { value: email } })
  await fireEvent.input(screen.getByLabelText(/^password$/i), { target: { value: password } })
  await fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('LoginForm', () => {
  beforeEach(() => {
    loginMock.mockReset()
    getCurrentUserMock.mockReset()
    verifyMfaLoginMock.mockReset()
    gotoMock.mockClear()
  })
  afterEach(() => cleanup())

  it('logs in successfully and redirects to nextPath', async () => {
    loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(LoginForm, { props: { nextPath: '/projects' } })
    await fillAndSubmit()

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects'))
    expect(loginMock).toHaveBeenCalledWith(fetch, {
      email: 'alex@example.com',
      password: 'correcthorsebattery',
    })
    expect(getCurrentUserMock).toHaveBeenCalledWith(fetch)
  })

  it('defaults nextPath to /dashboard when no prop is given', async () => {
    loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(LoginForm, { props: {} })
    await fillAndSubmit()

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  it('shows a friendly message for invalid_credentials without leaking detail', async () => {
    loginMock.mockRejectedValue(
      new ApiClientError(401, { code: 'invalid_credentials', message: 'nope' }, 'nope')
    )

    render(LoginForm, { props: {} })
    await fillAndSubmit()

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /check your email and password, then try again/i
    )
    expect(gotoMock).not.toHaveBeenCalled()
    // password field is cleared after a failed attempt
    expect((screen.getByLabelText(/^password$/i) as HTMLInputElement).value).toBe('')
  })

  it('shows the underlying Error message for a non-invalid_credentials API error', async () => {
    loginMock.mockRejectedValue(new Error('Service unavailable'))

    render(LoginForm, { props: {} })
    await fillAndSubmit()

    expect((await screen.findByRole('alert')).textContent).toMatch('Service unavailable')
  })

  it('shows a generic message for a thrown non-Error value', async () => {
    loginMock.mockRejectedValue('weird failure')

    render(LoginForm, { props: {} })
    await fillAndSubmit()

    expect((await screen.findByRole('alert')).textContent).toMatch(/sign in failed/i)
  })

  it('disables the submit button and shows pending copy while the request is in flight', async () => {
    let resolveLogin: (value: unknown) => void = () => {}
    loginMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve
      })
    )

    render(LoginForm, { props: {} })
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'alex@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'correcthorsebattery' },
    })
    const button = screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement
    await fireEvent.click(button)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toMatch(/signing in/i)

    resolveLogin({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it('ignores re-entrant submit attempts while a request is already pending', async () => {
    let resolveLogin: (value: unknown) => void = () => {}
    loginMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve
      })
    )
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(LoginForm, { props: {} })
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'alex@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'correcthorsebattery' },
    })
    const button = screen.getByRole('button', { name: /sign in/i })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(loginMock).toHaveBeenCalledTimes(1)
    resolveLogin({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it('switches to the MFA challenge form when the login response requires MFA', async () => {
    loginMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

    render(LoginForm, { props: {} })
    await fillAndSubmit()

    expect(
      await screen.findByText(/mfa verification is required to finish signing in/i)
    ).toBeTruthy()
    expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
    expect(getCurrentUserMock).not.toHaveBeenCalled()
  })

  it('lets the user abandon the MFA challenge and return to the password form', async () => {
    loginMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

    render(LoginForm, { props: {} })
    await fillAndSubmit()
    await screen.findByLabelText(/authenticator code/i)

    await fireEvent.click(screen.getByRole('button', { name: /use a different password/i }))

    expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull()
  })

  it('shows the expiry status message and returns to the login form when MFA restarts', async () => {
    loginMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

    render(LoginForm, { props: {} })
    await fillAndSubmit()
    await screen.findByLabelText(/authenticator code/i)

    // Trigger the MfaLoginForm's onExpired callback via an expired-token verification failure.
    verifyMfaLoginMock.mockRejectedValue({ code: 'mfa_token_expired' })

    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))

    expect(
      await screen.findByText(/your login step expired\. please sign in again\./i)
    ).toBeTruthy()
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
  })
})
