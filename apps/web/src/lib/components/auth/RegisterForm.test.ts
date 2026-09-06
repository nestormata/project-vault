import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'

const registerMock = vi.hoisted(() => vi.fn())
const lookupSsoDomainMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const setPreAuthThemeMock = vi.hoisted(() => vi.fn())
const writePreAuthThemeCacheMock = vi.hoisted(() => vi.fn())
const setLocaleMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const getLocaleMock = vi.hoisted(() => vi.fn(() => 'es'))
const markRegistrationLocalePendingMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/auth.js', () => ({
  register: registerMock,
  lookupSsoDomain: lookupSsoDomainMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
  invalidateAll: invalidateAllMock,
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
vi.mock('./registration-locale.js', () => ({
  markRegistrationLocalePending: markRegistrationLocalePendingMock,
}))

import RegisterForm from './RegisterForm.svelte'

describe('RegisterForm', () => {
  beforeEach(() => {
    registerMock.mockReset()
    lookupSsoDomainMock.mockReset()
    lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })
    gotoMock.mockClear()
    invalidateAllMock.mockClear()
    setPreAuthThemeMock.mockReset()
    setLocaleMock.mockClear()
    getLocaleMock.mockReturnValue('es')
    markRegistrationLocalePendingMock.mockReset()
  })
  afterEach(() => cleanup())

  it('shows the pre-auth language switcher and preserves all typed registration fields', async () => {
    render(RegisterForm)
    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'alex@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Español' }))

    expect(setLocaleMock).toHaveBeenCalledWith('es', { reload: false })
    expect((screen.getByLabelText(/email/i) as HTMLInputElement).value).toBe('alex@example.com')
    expect((screen.getByLabelText(/organization name/i) as HTMLInputElement).value).toBe('Acme')
    expect((screen.getByLabelText(/^password$/i) as HTMLInputElement).value).toBe(
      'super-secret-password'
    )
  })

  // Story 1.20 AC-6: self-signup now always resolves to the generic accepted shape (no
  // userId/orgId), identical whether the submitted email was novel or already registered — the
  // form must show the generic message, redirect to the same unchanged path, and skip the
  // locale-pending marker (documented, accepted minor UX regression), with no branching that
  // could reintroduce the enumeration oracle at the UI layer.
  const GENERIC_ACCEPTED_MESSAGE =
    'If that email is available, your account has been created and you can sign in.'

  it.each([
    ['a novel email', 'alex-novel@example.com'],
    ['an already-registered email', 'alex-taken@example.com'],
  ])(
    'Story 1.20 AC-6: self-signup with %s shows the generic confirmation and redirects to /login?reason=registered, without pre-seeding a locale marker',
    async (_label, email) => {
      registerMock.mockResolvedValue({ message: GENERIC_ACCEPTED_MESSAGE })

      render(RegisterForm)

      expect(screen.getByLabelText(/organization name/i)).toBeTruthy()
      await fireEvent.input(screen.getByLabelText(/email/i), { target: { value: email } })
      await fireEvent.input(screen.getByLabelText(/organization name/i), {
        target: { value: 'Acme' },
      })
      await fireEvent.input(screen.getByLabelText(/^password$/i), {
        target: { value: 'super-secret-password' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

      await waitFor(() =>
        expect(registerMock).toHaveBeenCalledWith(fetch, {
          email,
          password: 'super-secret-password',
          orgName: 'Acme',
          invitationToken: undefined,
        })
      )
      await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/login?reason=registered'))
      expect((await screen.findByRole('status')).textContent).toContain(GENERIC_ACCEPTED_MESSAGE)
      expect(markRegistrationLocalePendingMock).not.toHaveBeenCalled()
    }
  )

  it('hides the org-name field and readonly-locks email when an invitationToken is supplied, redirecting into the project', async () => {
    registerMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      email: 'invited@example.com',
      orgName: 'Acme',
      role: 'member',
      invitedProject: { projectId: 'proj-1', projectName: 'Payments', role: 'member' },
    })

    render(RegisterForm, {
      props: { invitationToken: 'tok-1', prefillEmail: 'invited@example.com' },
    })

    expect(screen.queryByLabelText(/organization name/i)).toBeNull()
    const emailInput = screen.getByLabelText(/email/i) as HTMLInputElement
    expect(emailInput.readOnly).toBe(true)
    expect(emailInput.value).toBe('invited@example.com')

    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    await waitFor(() =>
      expect(registerMock).toHaveBeenCalledWith(fetch, {
        email: 'invited@example.com',
        password: 'super-secret-password',
        invitationToken: 'tok-1',
      })
    )
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects/proj-1'))
  })

  it('shows the Error message and clears the password field on a failed registration', async () => {
    registerMock.mockRejectedValue(new Error('Email already registered'))

    render(RegisterForm)

    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'dup@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/email already registered/i)
    expect((screen.getByLabelText(/^password$/i) as HTMLInputElement).value).toBe('')
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('shows a generic failure message when registration rejects with a non-Error value', async () => {
    registerMock.mockRejectedValue('weird failure')

    render(RegisterForm)

    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'dup@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/registration failed/i)
  })

  it('Story 23.2 AC-6a: shows the honest native_login_disabled message, not a generic failure', async () => {
    registerMock.mockRejectedValue({ code: 'native_login_disabled', message: 'raw api message' })

    render(RegisterForm)

    await fireEvent.input(screen.getByLabelText(/email/i), {
      target: { value: 'second-user@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme' },
    })
    await fireEvent.input(screen.getByLabelText(/^password$/i), {
      target: { value: 'super-secret-password' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /this vault is configured for external sign-in/i
    )
    expect((screen.getByLabelText(/^password$/i) as HTMLInputElement).value).toBe('')
  })

  // Story 16.5 AC-1: RegisterForm resolves org branding for a free-typed email (self-registration).
  describe('pre-auth theme resolution — free-typed email (AC-1)', () => {
    it('applies the resolved theme when the email field is blurred', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })

      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)
      await fireEvent.input(emailInput, { target: { value: 'jordan@acme.com' } })
      await fireEvent.blur(emailInput)

      await waitFor(() =>
        expect(lookupSsoDomainMock).toHaveBeenCalledWith(fetch, 'jordan@acme.com')
      )
      await waitFor(() =>
        expect(setPreAuthThemeMock).toHaveBeenCalledWith(
          'acme-brand',
          '[data-theme="acme-brand"] {}'
        )
      )
    })

    it('does not fire a lookup when an obviously-invalid email is blurred', async () => {
      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)
      await fireEvent.input(emailInput, { target: { value: 'not-an-email' } })
      await fireEvent.blur(emailInput)

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lookupSsoDomainMock).not.toHaveBeenCalled()
    })

    it('falls open to the base theme when the domain has no org-theme mapping', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })

      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)
      await fireEvent.input(emailInput, { target: { value: 'jordan@startupinc.example' } })
      await fireEvent.blur(emailInput)

      await waitFor(() => expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null))
    })

    it('falls open to the base theme when the lookup call rejects (network/server error)', async () => {
      lookupSsoDomainMock.mockRejectedValue(new TypeError('Failed to fetch'))

      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)
      await fireEvent.input(emailInput, { target: { value: 'jordan@acme.com' } })
      await fireEvent.blur(emailInput)

      await waitFor(() => expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null))
    })

    it('discards a stale, out-of-order response for an email the user has since changed away from', async () => {
      let resolveFirst: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )

      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)

      // First (slow) lookup kicks off for jordan@acme.com...
      await fireEvent.input(emailInput, { target: { value: 'jordan@acme.com' } })
      await fireEvent.blur(emailInput)

      // ...user changes their mind before it resolves, and the second (fast) lookup wins.
      lookupSsoDomainMock.mockResolvedValueOnce({ ssoRequired: false })
      await fireEvent.input(emailInput, { target: { value: 'jordan@other.example' } })
      await fireEvent.blur(emailInput)

      await waitFor(() => expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null))
      setPreAuthThemeMock.mockClear()

      // The stale first response resolves late, for an email the field no longer holds — must
      // never be applied.
      resolveFirst({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(setPreAuthThemeMock).not.toHaveBeenCalled()
    })

    it('never fires a lookup on input alone, only on blur', async () => {
      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)
      await fireEvent.input(emailInput, { target: { value: 'jordan@acme.com' } })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lookupSsoDomainMock).not.toHaveBeenCalled()
    })

    it('does not block or delay registration submission while a theme lookup is still in flight (Pre-Mortem #4)', async () => {
      let resolveLookup: (value: unknown) => void = () => {}
      lookupSsoDomainMock.mockReturnValue(
        new Promise((resolve) => {
          resolveLookup = resolve
        })
      )
      registerMock.mockResolvedValue({
        userId: 'u1',
        orgId: 'o1',
        email: 'jordan@acme.com',
        orgName: 'Jordans Org',
        role: 'owner',
      })

      render(RegisterForm)
      const emailInput = screen.getByLabelText(/email/i)
      await fireEvent.input(emailInput, { target: { value: 'jordan@acme.com' } })
      await fireEvent.blur(emailInput)

      const submitButton = screen.getByRole('button', {
        name: /create account/i,
      }) as HTMLButtonElement
      expect(submitButton.disabled).toBe(false)

      await fireEvent.input(screen.getByLabelText(/organization name/i), {
        target: { value: 'Jordans Org' },
      })
      await fireEvent.input(screen.getByLabelText(/^password$/i), {
        target: { value: 'super-secret-password' },
      })
      await fireEvent.click(submitButton)

      await waitFor(() => expect(registerMock).toHaveBeenCalled())
      await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/login?reason=registered'))

      // Clean up the still-pending lookup promise so it doesn't leak into other tests.
      resolveLookup({ ssoRequired: false })
    })
  })

  // Story 16.5 AC-2: RegisterForm resolves org branding for a pre-filled, read-only invitation email.
  describe('pre-auth theme resolution — pre-filled invitation email (AC-2)', () => {
    it('fires the lookup once on mount using prefillEmail, without waiting for a blur', async () => {
      lookupSsoDomainMock.mockResolvedValue({
        ssoRequired: false,
        theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
      })

      render(RegisterForm, {
        props: { invitationToken: 'tok-1', prefillEmail: 'alex@acme.com' },
      })

      await waitFor(() => expect(lookupSsoDomainMock).toHaveBeenCalledWith(fetch, 'alex@acme.com'))
      await waitFor(() =>
        expect(setPreAuthThemeMock).toHaveBeenCalledWith(
          'acme-brand',
          '[data-theme="acme-brand"] {}'
        )
      )
    })

    it('falls open to the base theme when the invitation email has no org-theme mapping', async () => {
      lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })

      render(RegisterForm, {
        props: { invitationToken: 'tok-1', prefillEmail: 'alex@startupinc.example' },
      })

      await waitFor(() => expect(setPreAuthThemeMock).toHaveBeenCalledWith(null, null))
    })

    it('does not fire a mount-time lookup for the non-invitation (empty prefill) path', async () => {
      render(RegisterForm)

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(lookupSsoDomainMock).not.toHaveBeenCalled()
    })
  })
})
