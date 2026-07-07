import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'
import type { AuthUser } from '$lib/api/auth.js'

const enrollMfaMock = vi.hoisted(() => vi.fn())
const verifyMfaEnrollmentMock = vi.hoisted(() => vi.fn())
const regenerateMfaRecoveryCodesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/auth.js', () => ({
  enrollMfa: enrollMfaMock,
  verifyMfaEnrollment: verifyMfaEnrollmentMock,
  regenerateMfaRecoveryCodes: regenerateMfaRecoveryCodesMock,
}))

import MfaEnrollmentPanel from './MfaEnrollmentPanel.svelte'

function unenrolledUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    orgRole: 'owner',
    mfaEnrolled: false,
    mfaEnrolledAt: null,
    remainingRecoveryCodesCount: null,
    mfaStatus: {
      enrollmentRequired: false,
      gracePeriodActive: false,
      gracePeriodExpiresAt: null,
      gracePeriodDaysRemaining: null,
      bannerMessage: null,
    },
    ...overrides,
  }
}

const enrollResponse = {
  enrollmentId: 'enroll-1',
  otpauthUrl: 'otpauth://totp/Project%20Vault:alex@example.com?secret=ABC&issuer=Vault',
  secret: 'JBSWY3DPEHPK3PXP',
  qrCodeSvg: '<svg data-testid="mfa-qr">fake-qr</svg>',
}

describe('MfaEnrollmentPanel', () => {
  beforeEach(() => {
    enrollMfaMock.mockReset()
    verifyMfaEnrollmentMock.mockReset()
    regenerateMfaRecoveryCodesMock.mockReset()
  })
  afterEach(() => cleanup())

  it('shows a call to action when MFA is not enrolled and nothing is pending', () => {
    render(MfaEnrollmentPanel, { props: { initialUser: unenrolledUser() } })

    expect(screen.getByRole('button', { name: /set up authenticator app/i })).toBeTruthy()
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull()
  })

  it('starts enrollment and renders the QR code + secret + TOTP field', async () => {
    enrollMfaMock.mockResolvedValue(enrollResponse)
    render(MfaEnrollmentPanel, { props: { initialUser: unenrolledUser() } })

    await fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }))

    expect(enrollMfaMock).toHaveBeenCalledWith(fetch)
    expect(await screen.findByText(enrollResponse.secret)).toBeTruthy()
    expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy()
    // Rendered as an <img data:> URI, not raw {@html} — this app's static-hardening test bans
    // {@html} outright, so the QR SVG must never land in the DOM as live markup.
    const qrImage = screen.getByRole('img', { name: /authenticator app qr code/i })
    expect(qrImage.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it('verifies the TOTP and shows one-time recovery codes on success', async () => {
    enrollMfaMock.mockResolvedValue(enrollResponse)
    verifyMfaEnrollmentMock.mockResolvedValue({
      mfaEnrolledAt: '2026-07-07T12:00:00.000Z',
      recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
    })
    render(MfaEnrollmentPanel, { props: { initialUser: unenrolledUser() } })

    await fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }))
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }))

    expect(verifyMfaEnrollmentMock).toHaveBeenCalledWith(fetch, { totp: '123456' })
    expect(await screen.findByText('aaaa-bbbb-cccc')).toBeTruthy()
    expect(screen.getByText('dddd-eeee-ffff')).toBeTruthy()
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull()
  })

  it('shows a friendly message when the TOTP code is rejected, without losing the QR', async () => {
    enrollMfaMock.mockResolvedValue(enrollResponse)
    verifyMfaEnrollmentMock.mockRejectedValue(
      new ApiClientError(422, { code: 'invalid_totp', message: 'bad' }, 'bad')
    )
    render(MfaEnrollmentPanel, { props: { initialUser: unenrolledUser() } })

    await fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }))
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '000000' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }))

    expect(await screen.findByText(/that code was not accepted/i)).toBeTruthy()
    expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy()
  })

  it('dismissing the saved recovery codes reveals the enabled status', async () => {
    enrollMfaMock.mockResolvedValue(enrollResponse)
    verifyMfaEnrollmentMock.mockResolvedValue({
      mfaEnrolledAt: '2026-07-07T12:00:00.000Z',
      recoveryCodes: ['aaaa-bbbb-cccc'],
    })
    render(MfaEnrollmentPanel, { props: { initialUser: unenrolledUser() } })

    await fireEvent.click(screen.getByRole('button', { name: /set up authenticator app/i }))
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }))
    await screen.findByText('aaaa-bbbb-cccc')

    await fireEvent.click(screen.getByRole('button', { name: /i.?ve saved these codes/i }))

    expect(screen.getByText(/mfa is enabled/i)).toBeTruthy()
    expect(screen.queryByText('aaaa-bbbb-cccc')).toBeNull()
  })

  it('renders the enabled status directly when the user is already enrolled', () => {
    render(MfaEnrollmentPanel, {
      props: {
        initialUser: unenrolledUser({
          mfaEnrolled: true,
          mfaEnrolledAt: '2026-06-01T00:00:00.000Z',
          remainingRecoveryCodesCount: 3,
        }),
      },
    })

    expect(screen.getByText(/mfa is enabled/i)).toBeTruthy()
    expect(screen.getByText('3 unused recovery codes remain.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /set up authenticator app/i })).toBeNull()
  })

  it('regenerates recovery codes after confirming with a TOTP code', async () => {
    regenerateMfaRecoveryCodesMock.mockResolvedValue({
      recoveryCodes: ['9999-8888-7777'],
      generatedAt: '2026-07-07T13:00:00.000Z',
    })
    render(MfaEnrollmentPanel, {
      props: {
        initialUser: unenrolledUser({
          mfaEnrolled: true,
          mfaEnrolledAt: '2026-06-01T00:00:00.000Z',
          remainingRecoveryCodesCount: 0,
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /regenerate recovery codes/i }))
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '654321' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /confirm regeneration/i }))

    expect(regenerateMfaRecoveryCodesMock).toHaveBeenCalledWith(fetch, { totp: '654321' })
    expect(await screen.findByText('9999-8888-7777')).toBeTruthy()
  })

  it('guards double submission while a request is in flight', async () => {
    let resolveEnroll: (value: typeof enrollResponse) => void = () => {}
    enrollMfaMock.mockReturnValue(
      new Promise((resolve) => {
        resolveEnroll = resolve
      })
    )
    render(MfaEnrollmentPanel, { props: { initialUser: unenrolledUser() } })

    const button = screen.getByRole('button', { name: /set up authenticator app/i })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(enrollMfaMock).toHaveBeenCalledTimes(1)
    resolveEnroll(enrollResponse)
    await waitFor(() => expect(screen.getByLabelText(/authenticator code/i)).toBeTruthy())
  })
})
