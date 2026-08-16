import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const loginMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const lookupSsoDomainMock = vi.hoisted(() => vi.fn())
const ssoStartMock = vi.hoisted(() => vi.fn())
const ssoCallbackMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const pageMock = vi.hoisted(() => ({ url: new URL('http://localhost/login') }))

vi.mock('$lib/api/auth.js', () => ({
  login: loginMock,
  getCurrentUser: getCurrentUserMock,
  verifyMfaLogin: verifyMfaLoginMock,
  lookupSsoDomain: lookupSsoDomainMock,
  ssoStart: ssoStartMock,
  ssoCallback: ssoCallbackMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import LoginPage from './+page.svelte'
import { setLocale } from '$lib/paraglide/runtime.js'

// Story 14.4: the login screen is now email-first/two-step — Step A (email + Continue) always
// runs before the password field renders (AC-4), even for an email with no SSO mapping (the case
// every test in this file exercises). Mirrors LoginForm.test.ts's own fillAndSubmitPassword helper.
async function submitLogin() {
  lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
  await fireEvent.input(screen.getByLabelText(/email/i), {
    target: { value: 'alex@example.com' },
  })
  await fireEvent.click(screen.getByRole('button', { name: /continue/i }))
  await screen.findByLabelText(/^password$/i)
  await fireEvent.input(screen.getByLabelText(/^password$/i), {
    target: { value: 'super-secret-password' },
  })
  await fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('/login +page.svelte', () => {
  beforeEach(() => {
    document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
    pageMock.url = new URL('http://localhost/login')
    loginMock.mockReset()
    getCurrentUserMock.mockReset()
    lookupSsoDomainMock.mockReset()
    ssoStartMock.mockReset()
    ssoCallbackMock.mockReset()
    gotoMock.mockClear()
    loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
  })
  afterEach(() => cleanup())

  it('renders the complete login shell in Spanish, including the safe registered reason', () => {
    setLocale('es', { reload: false })
    pageMock.url = new URL('http://localhost/login?reason=registered')
    render(LoginPage)

    expect(document.title).toBe('Iniciar sesión | Project Vault')
    expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeTruthy()
    expect(screen.getByText('Usa tu cuenta de Project Vault para continuar.')).toBeTruthy()
    expect(screen.getByText('Cuenta creada. Inicia sesión para continuar.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Registrarse' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '¿No puedes acceder a tu cuenta?' })).toBeTruthy()
  })

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

  it.each([
    {
      name: 'redirects to a same-origin ?next path after a successful login',
      next: '%2Fprojects',
      expected: '/projects',
    },
    {
      name: 'falls back to /dashboard for a protocol-relative //-prefixed ?next (open-redirect guard)',
      next: '%2F%2Fevil.com',
      expected: '/dashboard',
    },
    {
      name: 'falls back to /dashboard for a ?next value that is not a leading-slash path',
      next: 'https%3A%2F%2Fevil.com',
      expected: '/dashboard',
    },
  ])('$name', async ({ next, expected }) => {
    pageMock.url = new URL(`http://localhost/login?next=${next}`)
    render(LoginPage)
    await submitLogin()
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith(expected))
  })

  describe('Story 23.2 AC-13: nativeLoginEnabled', () => {
    it('hides the Register and Recovery links when native login is disabled', () => {
      render(LoginPage, { props: { data: { nativeLoginEnabled: false } } })
      expect(screen.queryByRole('link', { name: /create.*account|register/i })).toBeNull()
      expect(screen.queryByRole('link', { name: /can't access your account/i })).toBeNull()
    })

    it('shows the Register and Recovery links when native login is enabled (default)', () => {
      render(LoginPage)
      expect(screen.getByRole('link', { name: /can't access your account/i })).toBeTruthy()
    })

    it('renders a neutral, retryable state and no form at all when the health status is unknown (cold-start failure)', () => {
      render(LoginPage, { props: { data: { nativeLoginEnabled: null } } })
      expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
      expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
      expect(screen.queryByLabelText(/email/i)).toBeNull()
    })
  })
})
