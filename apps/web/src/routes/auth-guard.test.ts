import { describe, expect, it, vi } from 'vitest'
import { isAuthPath, isProtectedAppPath, resolveAuthContext } from '$lib/server/auth-guard.js'
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

  it('treats a successful but empty auth response and non-401 failures as unauthenticated', async () => {
    await expect(
      resolveAuthContext({
        fetchFn: vi.fn().mockResolvedValue(jsonResponse({})),
        cookieHeader: '',
      })
    ).resolves.toEqual({ status: 'unauthenticated' })
    await expect(
      resolveAuthContext({
        fetchFn: vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 })),
        cookieHeader: 'refresh-token=refresh',
      })
    ).resolves.toEqual({ status: 'unauthenticated' })
  })

  it('maps refresh network failure to session-expired', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockRejectedValueOnce(new Error('offline'))
    await expect(
      resolveAuthContext({ fetchFn, cookieHeader: 'refresh-token=refresh' })
    ).resolves.toEqual({ status: 'unauthenticated', reason: 'session-expired' })
  })

  it.each([
    ['retry network failure', new Error('offline')],
    ['retry non-success', jsonResponse({}, { status: 401 })],
    ['retry empty body', jsonResponse({})],
  ])('maps %s after a successful refresh to session-expired', async (_label, retryResult) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
    if (retryResult instanceof Error) fetchFn.mockRejectedValueOnce(retryResult)
    else fetchFn.mockResolvedValueOnce(retryResult)

    await expect(
      resolveAuthContext({
        fetchFn,
        cookieHeader: 'access-token=old; refresh-token=refresh',
      })
    ).resolves.toEqual({ status: 'unauthenticated', reason: 'session-expired' })
  })

  it('merges replaced and new cookies while ignoring malformed Set-Cookie fragments', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: {
            'set-cookie':
              'access-token=new=with-equals; HttpOnly, session-extra=value; Path=/, malformed',
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: authUser }))

    await expect(
      resolveAuthContext({
        fetchFn,
        cookieHeader: 'access-token=old; refresh-token=refresh; malformed',
      })
    ).resolves.toEqual({ status: 'authenticated', user: authUser })
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/auth/me', {
      credentials: 'include',
      headers: {
        Cookie: 'access-token=new=with-equals; refresh-token=refresh; session-extra=value',
      },
    })
  })
})

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

  it('covers every protected prefix and rejects lookalike/public paths', () => {
    for (const prefix of ['/projects', '/credentials', '/alerts', '/health']) {
      expect(isProtectedAppPath(prefix)).toBe(true)
      expect(isProtectedAppPath(`${prefix}/child`)).toBe(true)
    }
    expect(isProtectedAppPath('/project')).toBe(false)
    expect(isProtectedAppPath('/login')).toBe(false)
  })

  it('recognizes only login and registration as auth paths', () => {
    expect(isAuthPath('/login')).toBe(true)
    expect(isAuthPath('/register')).toBe(true)
    expect(isAuthPath('/login/help')).toBe(false)
    expect(isAuthPath('/dashboard')).toBe(false)
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
