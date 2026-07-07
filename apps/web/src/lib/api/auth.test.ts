import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import {
  enrollMfa,
  getCurrentUser,
  login,
  logout,
  regenerateMfaRecoveryCodes,
  register,
  verifyMfaEnrollment,
  verifyMfaLogin,
} from './auth.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('auth API helpers', () => {
  it('register sends the expected body and returns the backend data envelope', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            userId: '00000000-0000-4000-8000-000000000001',
            orgId: '00000000-0000-4000-8000-000000000002',
            email: 'alex@example.com',
            orgName: 'Example Org',
            role: 'owner',
          },
        },
        { status: 201 }
      )
    )

    const result = await register(fetchFn, {
      email: 'alex@example.com',
      password: 'twelve-characters',
      orgName: 'Example Org',
    })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alex@example.com',
        password: 'twelve-characters',
        orgName: 'Example Org',
      }),
    })
    expect(result.email).toBe('alex@example.com')
  })

  it('login success returns session data without exposing tokens', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          userId: '00000000-0000-4000-8000-000000000001',
          orgId: '00000000-0000-4000-8000-000000000002',
          expiresAt: '2026-06-27T19:00:00.000Z',
        },
      })
    )

    const result = await login(fetchFn, {
      email: 'alex@example.com',
      password: 'twelve-characters',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      })
    )
    expect(result).toEqual({
      userId: '00000000-0000-4000-8000-000000000001',
      orgId: '00000000-0000-4000-8000-000000000002',
      expiresAt: '2026-06-27T19:00:00.000Z',
    })
    expect(JSON.stringify(result)).not.toContain('token')
  })

  it('login returns an MFA challenge when the backend requires verification', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          mfaRequired: true,
          mfaToken: 'u8Jx2k4mQ1pZr7sV9aBcDe',
        },
      })
    )

    const result = await login(fetchFn, {
      email: 'alex@example.com',
      password: 'twelve-characters',
    })

    expect(result).toEqual({ mfaRequired: true, mfaToken: 'u8Jx2k4mQ1pZr7sV9aBcDe' })
  })

  it('verifyMfaLogin posts the transient token and TOTP then returns a session', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          userId: '00000000-0000-4000-8000-000000000001',
          orgId: '00000000-0000-4000-8000-000000000002',
          expiresAt: '2026-06-27T19:00:00.000Z',
        },
      })
    )

    const result = await verifyMfaLogin(fetchFn, {
      mfaToken: 'u8Jx2k4mQ1pZr7sV9aBcDe',
      totp: '123456',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/mfa/verify-login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ mfaToken: 'u8Jx2k4mQ1pZr7sV9aBcDe', totp: '123456' }),
      })
    )
    expect(result.expiresAt).toBe('2026-06-27T19:00:00.000Z')
  })

  it('logout handles 204 No Content', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    await expect(logout(fetchFn)).resolves.toBeUndefined()

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: {},
    })
  })

  it('auth errors normalize { code, message } into ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'invalid_credentials', message: 'Invalid email or password' },
          { status: 401 }
        )
      )

    await expect(
      login(fetchFn, { email: 'alex@example.com', password: 'bad-password' })
    ).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
      message: 'Invalid email or password',
    } satisfies Partial<ApiClientError>)
  })

  it('getCurrentUser unwraps the auth/me user context', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          userId: '00000000-0000-4000-8000-000000000001',
          orgId: '00000000-0000-4000-8000-000000000002',
          sessionId: '00000000-0000-4000-8000-000000000003',
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
        },
      })
    )

    await expect(getCurrentUser(fetchFn)).resolves.toMatchObject({ orgRole: 'owner' })
  })

  it('enrollMfa posts with no body and returns the pending enrollment secret/QR', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          enrollmentId: '00000000-0000-4000-8000-000000000004',
          otpauthUrl: 'otpauth://totp/Project%20Vault:alex@example.com?secret=ABC&issuer=Vault',
          secret: 'JBSWY3DPEHPK3PXP',
          qrCodeSvg: '<svg>fake</svg>',
        },
      })
    )

    const result = await enrollMfa(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/mfa/enroll', {
      method: 'POST',
      credentials: 'include',
      headers: {},
    })
    expect(result).toEqual({
      enrollmentId: '00000000-0000-4000-8000-000000000004',
      otpauthUrl: 'otpauth://totp/Project%20Vault:alex@example.com?secret=ABC&issuer=Vault',
      secret: 'JBSWY3DPEHPK3PXP',
      qrCodeSvg: '<svg>fake</svg>',
    })
  })

  it('verifyMfaEnrollment posts the TOTP and returns the enrolled-at timestamp plus recovery codes', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          mfaEnrolledAt: '2026-07-07T12:00:00.000Z',
          recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
        },
      })
    )

    const result = await verifyMfaEnrollment(fetchFn, { totp: '123456' })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/mfa/verify-enrollment', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totp: '123456' }),
    })
    expect(result).toEqual({
      mfaEnrolledAt: '2026-07-07T12:00:00.000Z',
      recoveryCodes: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
    })
  })

  it('verifyMfaEnrollment normalizes an invalid_totp rejection into an ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'invalid_totp', message: 'The authenticator code is incorrect.' },
          { status: 422 }
        )
      )

    await expect(verifyMfaEnrollment(fetchFn, { totp: '000000' })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_totp',
    } satisfies Partial<ApiClientError>)
  })

  it('regenerateMfaRecoveryCodes posts the TOTP and returns a fresh recovery code batch', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          recoveryCodes: ['1111-2222-3333'],
          generatedAt: '2026-07-07T12:05:00.000Z',
        },
      })
    )

    const result = await regenerateMfaRecoveryCodes(fetchFn, { totp: '654321' })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/mfa/regenerate-recovery-codes', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totp: '654321' }),
    })
    expect(result).toEqual({
      recoveryCodes: ['1111-2222-3333'],
      generatedAt: '2026-07-07T12:05:00.000Z',
    })
  })
})
