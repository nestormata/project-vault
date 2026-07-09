import { describe, expect, it, vi } from 'vitest'
import { resolveAuthContext } from '$lib/server/auth-guard.js'
import { jsonResponse } from '$lib/test/json-response.js'

const authUser = {
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  sessionId: '00000000-0000-4000-8000-000000000003',
  orgRole: 'owner' as const,
  isPlatformOperator: false,
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
}

describe('server auth guard', () => {
  it('valid /auth/me populates the auth context with incoming cookies', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: authUser }))

    const result = await resolveAuthContext({
      fetchFn,
      cookieHeader: 'access-token=access; refresh-token=refresh',
    })

    expect(result).toEqual({ status: 'authenticated', user: authUser })
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/me', {
      credentials: 'include',
      headers: { Cookie: 'access-token=access; refresh-token=refresh' },
    })
  })

  it('expired access with valid refresh retries /auth/me and forwards Set-Cookie', async () => {
    const setCookieHeaders = [
      'access-token=new-access; HttpOnly; Path=/',
      'refresh-token=new-refresh; HttpOnly; Path=/',
    ]
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'unauthorized', message: 'Unauthorized' }, { status: 401 })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { data: { expiresAt: '2026-06-27T19:00:00.000Z' } },
          { headers: { 'set-cookie': setCookieHeaders.join(', ') } }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: authUser }))
    const forwardedCookies: string[] = []

    const result = await resolveAuthContext({
      fetchFn,
      cookieHeader: 'access-token=old-access; refresh-token=old-refresh',
      forwardSetCookie: (value) => forwardedCookies.push(value),
    })

    expect(result).toEqual({ status: 'authenticated', user: authUser })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(fetchFn).toHaveBeenNthCalledWith(2, '/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { Cookie: 'access-token=old-access; refresh-token=old-refresh' },
    })
    expect(fetchFn).toHaveBeenNthCalledWith(3, '/api/v1/auth/me', {
      credentials: 'include',
      headers: { Cookie: 'access-token=new-access; refresh-token=new-refresh' },
    })
    expect(forwardedCookies).toEqual(setCookieHeaders)
  })

  it('treats auth API outages as unauthenticated instead of throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('API unavailable'))

    await expect(
      resolveAuthContext({
        fetchFn,
        cookieHeader: 'access-token=old-access; refresh-token=old-refresh',
      })
    ).resolves.toEqual({ status: 'unauthenticated' })
  })

  it('refresh failure returns a calm session-expired redirect reason', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'unauthorized', message: 'Unauthorized' }, { status: 401 })
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'refresh_token_invalid', message: 'Refresh token is invalid' },
          { status: 401 }
        )
      )

    await expect(
      resolveAuthContext({
        fetchFn,
        cookieHeader: 'access-token=old-access; refresh-token=old-refresh',
      })
    ).resolves.toEqual({ status: 'unauthenticated', reason: 'session-expired' })
  })

  it('does not call refresh for anonymous requests without a refresh cookie', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'unauthorized', message: 'Unauthorized' }, { status: 401 })
      )

    await expect(resolveAuthContext({ fetchFn, cookieHeader: null })).resolves.toEqual({
      status: 'unauthenticated',
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/auth/me', {
      credentials: 'include',
    })
  })
})

import { isProtectedAppPath } from '$lib/server/auth-guard.js'

describe('isProtectedAppPath', () => {
  it('AC-O1: /platform and its sub-paths are protected (sealed-vault redirect)', () => {
    expect(isProtectedAppPath('/platform')).toBe(true)
    expect(isProtectedAppPath('/platform/backups')).toBe(true)
    expect(isProtectedAppPath('/platform/settings')).toBe(true)
    expect(isProtectedAppPath('/platform/audit')).toBe(true)
    expect(isProtectedAppPath('/platform/upgrade')).toBe(true)
  })

  it('existing protected paths still work', () => {
    expect(isProtectedAppPath('/dashboard')).toBe(true)
    expect(isProtectedAppPath('/settings')).toBe(true)
    expect(isProtectedAppPath('/settings/audit')).toBe(true)
  })
})

import { getPrimaryNavItems } from '$lib/components/shell/nav-model.js'

describe('getPrimaryNavItems', () => {
  it('AC-A2: non-platform-operator gets no Platform Admin item', () => {
    const items = getPrimaryNavItems({ isPlatformOperator: false })
    expect(items.find((i) => i.href === '/platform')).toBeUndefined()
  })

  it('AC-A2: platform operator gets a Platform Admin nav item linking to /platform', () => {
    const items = getPrimaryNavItems({ isPlatformOperator: true })
    const platformItem = items.find((i) => i.href === '/platform')
    expect(platformItem).toBeDefined()
    expect(platformItem?.label).toBe('Platform Admin')
    expect(platformItem?.mobileLabel).toBe('Platform')
  })
})
