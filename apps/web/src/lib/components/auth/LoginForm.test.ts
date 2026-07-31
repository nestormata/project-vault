import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const loginMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const lookupSsoDomainMock = vi.hoisted(() => vi.fn())
const ssoStartMock = vi.hoisted(() => vi.fn())
const ssoCallbackMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const setPreAuthThemeMock = vi.hoisted(() => vi.fn())
const writePreAuthThemeCacheMock = vi.hoisted(() => vi.fn())
const setLocaleMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getLocaleMock = vi.hoisted(() => vi.fn(() => 'es'))
const patchUserLocaleMock = vi.hoisted(() => vi.fn())
const consumeRegistrationLocalePendingMock = vi.hoisted(() => vi.fn(() => false))

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

vi.mock('$lib/state/theme.svelte.js', () => ({
  setPreAuthTheme: setPreAuthThemeMock,
  writePreAuthThemeCache: writePreAuthThemeCacheMock,
}))

vi.mock('$lib/paraglide/runtime.js', () => ({
  experimentalStaticLocale: 'en',
  setLocale: setLocaleMock,
  getLocale: getLocaleMock,
}))

vi.mock('$lib/api/locale.js', () => ({ patchUserLocale: patchUserLocaleMock }))
vi.mock('./registration-locale.js', () => ({
  consumeRegistrationLocalePending: consumeRegistrationLocalePendingMock,
}))

import LoginForm from './LoginForm.svelte'

async function fillEmailAndContinue(email = 'alex@example.com') {
  await fireEvent.input(screen.getByLabelText(/email/i), { target: { value: email } })
  await fireEvent.click(screen.getByRole('button', { name: /continue/i }))
}

async function fillAndSubmitPassword(email = 'alex@example.com', password = 'correcthorsebattery') {
  lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
  await fillEmailAndContinue(email)
  await screen.findByLabelText(/^password$/i)
  await fireEvent.input(screen.getByLabelText(/^password$/i), { target: { value: password } })
  await fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('LoginForm', () => {
  beforeEach(() => {
    loginMock.mockReset()
    getCurrentUserMock.mockReset()
    verifyMfaLoginMock.mockReset()
    lookupSsoDomainMock.mockReset()
    ssoStartMock.mockReset()
    ssoCallbackMock.mockReset()
    gotoMock.mockClear()
    setPreAuthThemeMock.mockReset()
    writePreAuthThemeCacheMock.mockReset()
    setLocaleMock.mockClear()
    getLocaleMock.mockReturnValue('es')
    patchUserLocaleMock.mockReset()
    consumeRegistrationLocalePendingMock.mockReset()
    consumeRegistrationLocalePendingMock.mockReturnValue(false)
  })
  afterEach(() => cleanup())

  it('shows the pre-auth language switcher and preserves typed email when switching locale', async () => {
    render(LoginForm, { props: {} })
    const email = screen.getByLabelText(/email/i) as HTMLInputElement
    await fireEvent.input(email, { target: { value: 'alex@example.com' } })

    await fireEvent.click(screen.getByRole('button', { name: 'Español' }))

    expect(setLocaleMock).toHaveBeenCalledWith('es', { reload: false })
    expect(email.value).toBe('alex@example.com')
  })

  it('preserves a failed-login error when switching locale', async () => {
    lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
    loginMock.mockRejectedValue(new Error('Service unavailable'))
    render(LoginForm, { props: {} })
    await fillAndSubmitPassword('alex@example.com', 'correcthorsebattery')

    await fireEvent.click(screen.getByRole('button', { name: 'Español' }))

    expect(screen.getByRole('alert').textContent).toContain('Service unavailable')
  })

  it('persists the selected registration locale after the first authenticated login', async () => {
    consumeRegistrationLocalePendingMock.mockReturnValue(true)
    patchUserLocaleMock.mockResolvedValue({ locale: 'es' })
    lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
    loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(LoginForm, { props: { nextPath: '/dashboard' } })
    await fillAndSubmitPassword()

    await waitFor(() => expect(patchUserLocaleMock).toHaveBeenCalledWith(fetch, 'es'))
    expect(gotoMock).toHaveBeenCalledWith('/dashboard')
  })

  it('does not block login or navigation when registration locale persistence fails', async () => {
    const persistError = new Error('locale API unavailable')
    consumeRegistrationLocalePendingMock.mockReturnValue(true)
    patchUserLocaleMock.mockRejectedValue(persistError)
    loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(LoginForm, { props: { nextPath: '/dashboard' } })
    await fillAndSubmitPassword()

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
    expect(consoleError).toHaveBeenCalledWith(
      '[auth.registration_locale_persistence_failed]',
      persistError
    )
    consoleError.mockRestore()
  })

  describe('Step A: email-only entry (AC-1/AC-2/AC-4)', () => {
    it('shows only the email field and Continue button on initial render — no password field yet', () => {
      render(LoginForm, { props: {} })
      expect(screen.getByLabelText(/email/i)).toBeTruthy()
      expect(screen.queryByLabelText(/^password$/i)).toBeNull()
      expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy()
    })

    it('calls the domain-lookup endpoint with the typed email on Continue', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@acme.com')
      expect(lookupSsoDomainMock).toHaveBeenCalledWith(fetch, 'alex@acme.com')
    })

    it('disables the Continue button while the lookup is in flight (AC-11)', async () => {
      let resolveLookup: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve
        })
      )
      render(LoginForm, { props: {} })
      await fireEvent.input(screen.getByLabelText(/email/i), {
        target: { value: 'alex@example.com' },
      })
      const button = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement
      await fireEvent.click(button)
      expect(button.disabled).toBe(true)

      resolveLookup({ ssoRequired: false })
      expect(await screen.findByLabelText(/^password$/i)).toBeTruthy()
    })

    it('ignores a re-entrant Continue click while a lookup is already pending (AC-11)', async () => {
      let resolveLookup: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve
        })
      )
      render(LoginForm, { props: {} })
      await fireEvent.input(screen.getByLabelText(/email/i), {
        target: { value: 'alex@example.com' },
      })
      const button = screen.getByRole('button', { name: /continue/i })
      await fireEvent.click(button)
      await fireEvent.click(button)
      expect(lookupSsoDomainMock).toHaveBeenCalledTimes(1)
      resolveLookup({ ssoRequired: false })
      expect(await screen.findByLabelText(/^password$/i)).toBeTruthy()
    })
  })

  describe('Step B: no SSO mapping — password field renders (AC-2)', () => {
    it('renders the password field and proceeds with local login exactly as before', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
      getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

      render(LoginForm, { props: { nextPath: '/projects' } })
      await fillAndSubmitPassword('alex@example.com', 'correcthorsebattery')

      await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects'))
      expect(loginMock).toHaveBeenCalledWith(fetch, {
        email: 'alex@example.com',
        password: 'correcthorsebattery',
      })
    })

    it('defaults nextPath to /dashboard when no prop is given', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockResolvedValue({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
      getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

      render(LoginForm, { props: {} })
      await fillAndSubmitPassword()

      await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
    })

    it('shows a friendly message for invalid_credentials without leaking detail', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockRejectedValue(
        new ApiClientError(401, { code: 'invalid_credentials', message: 'nope' }, 'nope')
      )

      render(LoginForm, { props: {} })
      await fillAndSubmitPassword()

      expect((await screen.findByRole('alert')).textContent).toMatch(
        /check your email and password, then try again/i
      )
      expect(gotoMock).not.toHaveBeenCalled()
      expect((screen.getByLabelText(/^password$/i) as HTMLInputElement).value).toBe('')
    })

    it('shows the underlying Error message for a non-invalid_credentials API error', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockRejectedValue(new Error('Service unavailable'))

      render(LoginForm, { props: {} })
      await fillAndSubmitPassword()

      expect((await screen.findByRole('alert')).textContent).toMatch('Service unavailable')
    })

    it('switches to the MFA challenge form when the login response requires MFA', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

      render(LoginForm, { props: {} })
      await fillAndSubmitPassword()

      expect(
        await screen.findByText(/mfa verification is required to finish signing in/i)
      ).toBeTruthy()
      expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy()
      expect(gotoMock).not.toHaveBeenCalled()
      expect(getCurrentUserMock).not.toHaveBeenCalled()
    })

    it('lets the user abandon the MFA challenge and return to the password form', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

      render(LoginForm, { props: {} })
      await fillAndSubmitPassword()
      await screen.findByLabelText(/authenticator code/i)

      await fireEvent.click(screen.getByRole('button', { name: /use a different password/i }))

      expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
      expect(screen.queryByLabelText(/authenticator code/i)).toBeNull()
    })

    it('shows the expiry status message and returns to the login form when MFA restarts', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      loginMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

      render(LoginForm, { props: {} })
      await fillAndSubmitPassword()
      await screen.findByLabelText(/authenticator code/i)

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

  describe('Step B: SSO mapping — SSO step renders, no password field ever shown (AC-1)', () => {
    it('renders the SSO credential step instead of the password field', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: true,
        providerName: 'test.mock-sso-extension',
      })
      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@acme.com')

      await screen.findByLabelText(/sso credential/i)
      expect(screen.queryByLabelText(/^password$/i)).toBeNull()
    })

    it('completes the SSO flow (start + callback) and redirects like local login on success', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: true,
        providerName: 'test.mock-sso-extension',
      })
      ssoStartMock.mockResolvedValue({ state: 'opaque-state' })
      ssoCallbackMock.mockResolvedValue({
        userId: 'u1',
        orgId: 'o1',
        expiresAt: '2026-01-01T00:00:00Z',
      })
      getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

      render(LoginForm, { props: { nextPath: '/projects' } })
      await fillEmailAndContinue('alex@acme.com')
      await screen.findByLabelText(/sso credential/i)
      await fireEvent.input(screen.getByLabelText(/sso credential/i), {
        target: { value: 'fixture-credential' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /continue with sso/i }))

      await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects'))
      expect(ssoStartMock).toHaveBeenCalledWith(fetch, 'test.mock-sso-extension')
      expect(ssoCallbackMock).toHaveBeenCalledWith(fetch, 'test.mock-sso-extension', {
        credential: 'fixture-credential',
      })
    })

    it('surfaces an MFA challenge from the SSO callback the same way local login does', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: true,
        providerName: 'test.mock-sso-extension',
      })
      ssoStartMock.mockResolvedValue({ state: 'opaque-state' })
      ssoCallbackMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-sso' })

      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@acme.com')
      await screen.findByLabelText(/sso credential/i)
      await fireEvent.input(screen.getByLabelText(/sso credential/i), {
        target: { value: 'fixture-credential' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /continue with sso/i }))

      expect(
        await screen.findByText(/mfa verification is required to finish signing in/i)
      ).toBeTruthy()
      expect(gotoMock).not.toHaveBeenCalled()
    })

    it('lets the user go back to Step A via "use a different email"', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: true,
        providerName: 'test.mock-sso-extension',
      })
      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@acme.com')
      await screen.findByLabelText(/sso credential/i)

      await fireEvent.click(screen.getByRole('button', { name: /use a different email/i }))

      expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy()
      expect(screen.queryByLabelText(/sso credential/i)).toBeNull()
    })

    it('disables the SSO submit control while its own request is in flight (AC-11)', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: true,
        providerName: 'test.mock-sso-extension',
      })
      let resolveStart: (value: unknown) => void = () => {}
      ssoStartMock.mockReturnValue(
        new Promise((resolve) => {
          resolveStart = resolve
        })
      )
      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@acme.com')
      await screen.findByLabelText(/sso credential/i)
      await fireEvent.input(screen.getByLabelText(/sso credential/i), {
        target: { value: 'fixture-credential' },
      })
      const button = screen.getByRole('button', {
        name: /continue with sso/i,
      }) as HTMLButtonElement
      await fireEvent.click(button)
      expect(button.disabled).toBe(true)

      resolveStart({ state: 'opaque-state' })
      ssoCallbackMock.mockResolvedValue({
        userId: 'u1',
        orgId: 'o1',
        expiresAt: '2026-01-01T00:00:00Z',
      })
      getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
      await waitFor(() => expect(gotoMock).toHaveBeenCalled())
    })
  })

  describe('Fail-open paths (AC-3/AC-3a)', () => {
    it('falls open to the password field when the domain-lookup call rejects (network-level failure)', async () => {
      lookupSsoDomainMock.mockRejectedValue(new TypeError('Failed to fetch'))
      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@example.com')

      await screen.findByLabelText(/^password$/i)
      expect(screen.queryByLabelText(/sso credential/i)).toBeNull()
    })

    it('falls open to the password field when the domain-lookup call throws an ApiClientError (non-2xx)', async () => {
      lookupSsoDomainMock.mockRejectedValue(new ApiClientError(500, { message: 'boom' }, 'boom'))
      render(LoginForm, { props: {} })
      await fillEmailAndContinue('alex@example.com')

      expect(await screen.findByLabelText(/^password$/i)).toBeTruthy()
      expect(screen.queryByLabelText(/sso credential/i)).toBeNull()
    })
  })

  describe('Out-of-order response race guard (AC-8)', () => {
    it('a stale slower response never overrides the state a later, faster response already set', async () => {
      let resolveFirst: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve
        })
      )

      render(LoginForm, { props: {} })
      const emailInput = screen.getByLabelText(/email/i)
      const continueButton = screen.getByRole('button', { name: /continue/i })

      // First (slow) lookup kicks off for an SSO-mapped email...
      await fireEvent.input(emailInput, { target: { value: 'alex@acme.com' } })
      await fireEvent.click(continueButton)

      // ...but resolves only AFTER the component has already moved on. Since isSubmitting blocks
      // a second concurrent request from this same component instance, this test verifies the
      // narrower but essential half of AC-8: a response for an email value that no longer matches
      // current state must never be applied. Simulate that by changing `email` out from under the
      // pending promise directly, then resolving it.
      await fireEvent.input(emailInput, { target: { value: 'someone-else@example.com' } })

      resolveFirst({ ssoRequired: true, providerName: 'test.mock-sso-extension' })
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The stale response must never have applied — the user is still on Step A (or wherever it
      // left off), never silently dropped into the SSO step for an email they changed away from.
      expect(screen.queryByLabelText(/sso credential/i)).toBeNull()
    })
  })

  describe('Story 16.4 AC-3: pre-auth org-default theme application', () => {
    it('applies the resolved theme (name + css) reactively when the domain-lookup response carries one', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })
      render(LoginForm, { props: {} })

      await fillEmailAndContinue('newhire@acme.com')

      expect(setPreAuthThemeMock).toHaveBeenCalledWith('acme-brand', '[data-theme="acme-brand"] {}')
    })

    it('Story 16.6 AC-1: writes a successful resolution through to the localStorage cache — LoginForm bypasses resolvePreAuthTheme() (needs the raw ssoRequired/providerName fields), so it must call the cache write directly rather than relying on that helper', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })
      render(LoginForm, { props: {} })

      await fillEmailAndContinue('newhire@acme.com')

      expect(writePreAuthThemeCacheMock).toHaveBeenCalledWith(
        'acme-brand',
        '[data-theme="acme-brand"] {}'
      )
    })

    it('Story 16.6 AC-3: does not write to the cache on a miss (no theme in the response)', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      render(LoginForm, { props: {} })

      await fillEmailAndContinue('alex@no-branding.example')

      expect(writePreAuthThemeCacheMock).not.toHaveBeenCalled()
    })

    it('applies the theme before Step B (password) renders, not after', async () => {
      let resolveLookup: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve
        })
      )
      render(LoginForm, { props: {} })
      await fireEvent.input(screen.getByLabelText(/email/i), {
        target: { value: 'newhire@acme.com' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /continue/i }))

      expect(setPreAuthThemeMock).not.toHaveBeenCalled()
      expect(screen.queryByLabelText(/^password$/i)).toBeNull()

      resolveLookup({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })
      await screen.findByLabelText(/^password$/i)

      expect(setPreAuthThemeMock).toHaveBeenCalledWith('acme-brand', '[data-theme="acme-brand"] {}')
    })

    it('clears to the base theme (null, null) when the response carries no theme', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
      render(LoginForm, { props: {} })

      await fillEmailAndContinue('alex@no-branding.example')

      expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null)
    })

    it('clears to the base theme on a fail-open path (rejected lookup)', async () => {
      lookupSsoDomainMock.mockRejectedValue(new TypeError('Failed to fetch'))
      render(LoginForm, { props: {} })

      await fillEmailAndContinue('alex@example.com')
      await screen.findByLabelText(/^password$/i)

      expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null)
    })

    it('applies a resolved theme for an SSO-mapped domain before the SSO credential step renders', async () => {
      let resolveLookup: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve
        })
      )
      render(LoginForm, { props: {} })
      await fireEvent.input(screen.getByLabelText(/email/i), {
        target: { value: 'newhire@acme.com' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /continue/i }))

      resolveLookup({
        ssoRequired: true,
        providerName: 'test.mock-sso-extension',
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })
      await screen.findByLabelText(/sso credential/i)

      expect(setPreAuthThemeMock).toHaveBeenCalledWith('acme-brand', '[data-theme="acme-brand"] {}')
    })
  })
})
