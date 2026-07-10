import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const peekRecoveryMock = vi.hoisted(() => vi.fn())
const startRecoveryMfaMock = vi.hoisted(() => vi.fn())
const completeRecoveryMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const pageMock = vi.hoisted(() => ({ params: { token: 'tok-1' } }))

vi.mock('$lib/api/recovery.js', () => ({
  peekRecovery: peekRecoveryMock,
  startRecoveryMfa: startRecoveryMfaMock,
  completeRecovery: completeRecoveryMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import RecoveryTokenPage from './+page.svelte'

function requireForm(element: Element | null): HTMLFormElement {
  const form = element?.closest('form')
  if (!form) throw new Error('expected the button to be inside a form')
  return form
}

describe('/recovery/[token] +page.svelte', () => {
  beforeEach(() => {
    peekRecoveryMock.mockReset()
    startRecoveryMfaMock.mockReset()
    completeRecoveryMock.mockReset()
    gotoMock.mockClear()
    pageMock.params.token = 'tok-1'
  })
  afterEach(() => cleanup())

  it('shows the loading state, then the reset-password form once the peek succeeds', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })

    render(RecoveryTokenPage)

    expect(screen.getByText(/checking your recovery link/i)).toBeTruthy()
    expect(await screen.findByText(/set a new password/i)).toBeTruthy()
    expect(peekRecoveryMock).toHaveBeenCalledWith(fetch, 'tok-1')
  })

  it('maps recovery_token_not_found to the not-found notice', async () => {
    peekRecoveryMock.mockRejectedValue(
      new ApiClientError(404, { code: 'recovery_token_not_found', message: 'nf' }, 'nf')
    )
    render(RecoveryTokenPage)
    expect(await screen.findByText(/recovery link not found/i)).toBeTruthy()
  })

  it('maps recovery_token_expired to the expired notice', async () => {
    peekRecoveryMock.mockRejectedValue(
      new ApiClientError(410, { code: 'recovery_token_expired', message: 'exp' }, 'exp')
    )
    render(RecoveryTokenPage)
    expect(await screen.findByText(/recovery link expired/i)).toBeTruthy()
  })

  it('maps recovery_token_used to the already-used notice', async () => {
    peekRecoveryMock.mockRejectedValue(
      new ApiClientError(409, { code: 'recovery_token_used', message: 'used' }, 'used')
    )
    render(RecoveryTokenPage)
    expect(await screen.findByText(/recovery link already used/i)).toBeTruthy()
  })

  it('maps recovery_token_superseded to the superseded notice', async () => {
    peekRecoveryMock.mockRejectedValue(
      new ApiClientError(409, { code: 'recovery_token_superseded', message: 'sup' }, 'sup')
    )
    render(RecoveryTokenPage)
    expect(await screen.findByText(/a newer recovery link was requested/i)).toBeTruthy()
  })

  it('maps an unrecognized ApiClientError code to the generic error notice', async () => {
    peekRecoveryMock.mockRejectedValue(
      new ApiClientError(500, { code: 'something_else', message: 'x' }, 'x')
    )
    render(RecoveryTokenPage)
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy()
  })

  it('maps a non-ApiClientError failure (network error) to the generic error notice', async () => {
    peekRecoveryMock.mockRejectedValue(new Error('network down'))
    render(RecoveryTokenPage)
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy()
  })

  it('completes a plain password reset and redirects to login', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    completeRecoveryMock.mockResolvedValue({
      email: 'a@example.com',
      sessionsRevoked: 1,
      mfaReEnrolled: false,
    })

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)

    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() =>
      expect(completeRecoveryMock).toHaveBeenCalledWith(fetch, 'tok-1', {
        newPassword: 'super-secret-password-123',
      })
    )
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/login?reason=recovery-complete'))
  })

  it('shows recovery codes instead of redirecting when the response includes them, then continues to login on click', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    completeRecoveryMock.mockResolvedValue({
      email: 'a@example.com',
      sessionsRevoked: 1,
      mfaReEnrolled: true,
      recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
    })

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /reset password/i }))

    expect(await screen.findByText('aaaa-bbbb-cccc')).toBeTruthy()
    expect(screen.getByText('dddd-eeee-ffff')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: /continue to login/i }))
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=recovery-complete')
  })

  it('shows the ApiClientError message on a failed completion attempt', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    completeRecoveryMock.mockRejectedValue(
      new ApiClientError(
        400,
        { code: 'weak_password', message: 'Password too weak' },
        'Password too weak'
      )
    )

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /reset password/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/password too weak/i)
  })

  it('shows a generic error message when completion fails with a non-ApiClientError', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    completeRecoveryMock.mockRejectedValue(new Error('network blip'))

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /reset password/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /could not complete account recovery/i
    )
  })

  it('ignores re-entrant submit attempts while a completion request is pending', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    let resolveComplete: (value: unknown) => void = () => {}
    completeRecoveryMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve
      })
    )

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    const button = screen.getByRole('button', { name: /reset password/i })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(completeRecoveryMock).toHaveBeenCalledTimes(1)
    resolveComplete({ email: 'a@example.com', sessionsRevoked: 1, mfaReEnrolled: false })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it('shows the submitting/disabled pending state on the reset button', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    let resolveComplete: (value: unknown) => void = () => {}
    completeRecoveryMock.mockReturnValue(
      new Promise((resolve) => {
        resolveComplete = resolve
      })
    )

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    const button = screen.getByRole('button', { name: /reset password/i }) as HTMLButtonElement
    await fireEvent.click(button)

    expect(button.disabled).toBe(true)
    expect(button.textContent).toMatch(/resetting/i)

    resolveComplete({ email: 'a@example.com', sessionsRevoked: 1, mfaReEnrolled: false })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it('starts MFA re-enrollment when the checkbox is toggled on, showing the QR/secret', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    startRecoveryMfaMock.mockResolvedValue({
      otpauthUrl: 'otpauth://totp/x',
      secret: 'JBSWY3DPEHPK3PXP',
      qrCodeSvg: '<svg data-testid="qr">x</svg>',
    })

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)

    await fireEvent.click(screen.getByRole('checkbox', { name: /set up two-factor/i }))

    expect(startRecoveryMfaMock).toHaveBeenCalledWith(fetch, 'tok-1')
    expect(await screen.findByText(/manual entry key: jbswy3dpehpk3pxp/i)).toBeTruthy()
    expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy()
  })

  it('toggling MFA off and back on does not re-fetch the secret once already loaded', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    startRecoveryMfaMock.mockResolvedValue({
      otpauthUrl: 'otpauth://totp/x',
      secret: 'JBSWY3DPEHPK3PXP',
      qrCodeSvg: '<svg>x</svg>',
    })

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    const checkbox = screen.getByRole('checkbox', { name: /set up two-factor/i })
    await fireEvent.click(checkbox)
    await screen.findByLabelText(/authenticator code/i)

    await fireEvent.click(checkbox) // turn off
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull()

    await fireEvent.click(checkbox) // turn back on
    expect(startRecoveryMfaMock).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy()
  })

  it('shows a friendly error and unchecks MFA when starting MFA re-enrollment fails', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    startRecoveryMfaMock.mockRejectedValue(new Error('down'))

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.click(screen.getByRole('checkbox', { name: /set up two-factor/i }))

    expect(
      await screen.findByText(/could not start mfa re-enrollment\. you can still reset/i)
    ).toBeTruthy()
    expect(
      (screen.getByRole('checkbox', { name: /set up two-factor/i }) as HTMLInputElement).checked
    ).toBe(false)
  })

  it('blocks submission with a validation message when MFA is opted-in but the TOTP code is incomplete', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    startRecoveryMfaMock.mockResolvedValue({
      otpauthUrl: 'otpauth://totp/x',
      secret: 'JBSWY3DPEHPK3PXP',
      qrCodeSvg: '<svg>x</svg>',
    })

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    await fireEvent.click(screen.getByRole('checkbox', { name: /set up two-factor/i }))
    await screen.findByLabelText(/authenticator code/i)
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123' },
    })
    // fireEvent.click on the submit button goes through the browser's native constraint
    // validation, which the [0-9]{6} pattern attribute would itself block for a 3-digit value —
    // that's a different (already-covered) failure mode. Dispatching submit directly on the form
    // exercises this component's own JS-level guard instead.
    await fireEvent.submit(requireForm(screen.getByRole('button', { name: /reset password/i })))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /enter the 6-digit code from your authenticator app, or uncheck mfa setup/i
    )
    expect(completeRecoveryMock).not.toHaveBeenCalled()
  })

  it('submits totpCode alongside the password reset when MFA is opted-in with a valid code', async () => {
    peekRecoveryMock.mockResolvedValue({ email: 'a@example.com', mfaCurrentlyEnrolled: false })
    startRecoveryMfaMock.mockResolvedValue({
      otpauthUrl: 'otpauth://totp/x',
      secret: 'JBSWY3DPEHPK3PXP',
      qrCodeSvg: '<svg>x</svg>',
    })
    completeRecoveryMock.mockResolvedValue({
      email: 'a@example.com',
      sessionsRevoked: 1,
      mfaReEnrolled: true,
    })

    render(RecoveryTokenPage)
    await screen.findByText(/set a new password/i)
    await fireEvent.input(screen.getByLabelText(/new password/i), {
      target: { value: 'super-secret-password-123' },
    })
    await fireEvent.click(screen.getByRole('checkbox', { name: /set up two-factor/i }))
    await screen.findByLabelText(/authenticator code/i)
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() =>
      expect(completeRecoveryMock).toHaveBeenCalledWith(fetch, 'tok-1', {
        newPassword: 'super-secret-password-123',
        totpCode: '123456',
      })
    )
  })
})
