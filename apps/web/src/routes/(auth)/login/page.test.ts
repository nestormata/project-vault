import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const loginMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const pageMock = vi.hoisted(() => ({ url: new URL('http://localhost/login') }))

vi.mock('$lib/api/auth.js', () => ({
  login: loginMock,
  getCurrentUser: getCurrentUserMock,
  verifyMfaLogin: verifyMfaLoginMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import LoginPage from './+page.svelte'

async function submitLogin() {
  await fireEvent.input(screen.getByLabelText(/email/i), {
    target: { value: 'alex@example.com' },
  })
  await fireEvent.input(screen.getByLabelText(/^password$/i), {
    target: { value: 'super-secret-password' },
  })
  await fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('/login +page.svelte', () => {
  beforeEach(() => {
    pageMock.url = new URL('http://localhost/login')
    loginMock.mockReset()
    getCurrentUserMock.mockReset()
    gotoMock.mockClear()
    loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
  })
  afterEach(() => cleanup())

  it('shows the default sign-in message with no reason query param', () => {
    render(LoginPage)
    expect(screen.getByText(/sign in to continue\./i)).toBeTruthy()
  })

  it('shows the registered confirmation message for reason=registered', () => {
    pageMock.url = new URL('http://localhost/login?reason=registered')
    render(LoginPage)
    expect(screen.getByText(/account created\. sign in to continue\./i)).toBeTruthy()
  })

  it('shows the session-expired message for reason=session-expired', () => {
    pageMock.url = new URL('http://localhost/login?reason=session-expired')
    render(LoginPage)
    expect(screen.getByText(/your session ended\. sign in again to continue\./i)).toBeTruthy()
  })

  it('shows the recovery-complete message for reason=recovery-complete', () => {
    pageMock.url = new URL('http://localhost/login?reason=recovery-complete')
    render(LoginPage)
    expect(
      screen.getByText(/your password has been reset\. sign in with your new password\./i)
    ).toBeTruthy()
  })

  it('links to /register and /recovery, both of which are real routes', () => {
    render(LoginPage)
    const registerLink = screen.getByRole('link', { name: /register/i })
    const recoveryLink = screen.getByRole('link', { name: /can't access your account/i })
    expect(registerLink.getAttribute('href')).toBe('/register')
    expect(recoveryLink.getAttribute('href')).toBe('/recovery')
    expect(routeExists(registerLink.getAttribute('href') ?? '')).toBe(true)
    expect(routeExists(recoveryLink.getAttribute('href') ?? '')).toBe(true)
  })

  it('redirects to /dashboard by default when no ?next is given', async () => {
    render(LoginPage)
    await submitLogin()
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  it('redirects to a same-origin ?next path after a successful login', async () => {
    pageMock.url = new URL('http://localhost/login?next=%2Fprojects')
    render(LoginPage)
    await submitLogin()
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects'))
  })

  it('falls back to /dashboard for a protocol-relative //-prefixed ?next (open-redirect guard)', async () => {
    pageMock.url = new URL('http://localhost/login?next=%2F%2Fevil.com')
    render(LoginPage)
    await submitLogin()
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  it('falls back to /dashboard for a ?next value that is not a leading-slash path', async () => {
    pageMock.url = new URL('http://localhost/login?next=https%3A%2F%2Fevil.com')
    render(LoginPage)
    await submitLogin()
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })
})
