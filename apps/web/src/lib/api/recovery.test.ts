import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { completeRecovery, peekRecovery, requestRecovery, startRecoveryMfa } from './recovery.js'

describe('recovery API helpers', () => {
  it('requestRecovery posts the email and returns the generic message', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'If that email is registered...' }))

    const result = await requestRecovery(fetchFn, 'alex@example.com')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/recovery/request',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'alex@example.com' }),
      })
    )
    expect(result.message).toContain('registered')
  })

  it('peekRecovery GETs the token and returns the masked email + MFA flag', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { email: 'al***@example.com', mfaCurrentlyEnrolled: false } })
      )

    const result = await peekRecovery(fetchFn, 'opaque-token')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/recovery/opaque-token',
      expect.objectContaining({})
    )
    expect(result).toEqual({ email: 'al***@example.com', mfaCurrentlyEnrolled: false })
  })

  it('peekRecovery URL-encodes the token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { email: 'a***@x.com', mfaCurrentlyEnrolled: false } })
      )

    await peekRecovery(fetchFn, 'token/with slash')

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/auth/recovery/${encodeURIComponent('token/with slash')}`,
      expect.objectContaining({})
    )
  })

  it('startRecoveryMfa POSTs to the mfa/start endpoint and returns the QR payload', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          otpauthUrl: 'otpauth://totp/x',
          secret: 'ABCDEFGHIJKLMNOP',
          qrCodeSvg: '<svg></svg>',
        },
      })
    )

    const result = await startRecoveryMfa(fetchFn, 'opaque-token')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/recovery/opaque-token/mfa/start',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.secret).toBe('ABCDEFGHIJKLMNOP')
  })

  it('completeRecovery POSTs the new password (and optional totpCode) to the complete endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { email: 'alex@example.com', sessionsRevoked: 2, mfaReEnrolled: false },
      })
    )

    const result = await completeRecovery(fetchFn, 'opaque-token', {
      newPassword: 'a-strong-password-1!',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/recovery/opaque-token/complete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ newPassword: 'a-strong-password-1!' }),
      })
    )
    expect(result.sessionsRevoked).toBe(2)
  })

  it('completeRecovery includes totpCode when provided', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { email: 'alex@example.com', sessionsRevoked: 1, mfaReEnrolled: true },
      })
    )

    await completeRecovery(fetchFn, 'opaque-token', {
      newPassword: 'a-strong-password-2!',
      totpCode: '123456',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/recovery/opaque-token/complete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ newPassword: 'a-strong-password-2!', totpCode: '123456' }),
      })
    )
  })
})
