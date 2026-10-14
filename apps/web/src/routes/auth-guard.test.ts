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

  it('falls back to the combined set-cookie header when Headers.getSetCookie is unavailable', async () => {
    // Simulates a fetch implementation whose Headers object predates the getSetCookie() API,
    // forcing the header-splitting fallback path in getSetCookieHeaders().
    const setCookieCombined =
      'access-token=new-access; HttpOnly; Path=/, refresh-token=new-refresh; HttpOnly; Path=/'
    const refreshResponse = jsonResponse(
      { data: { expiresAt: '2026-06-27T19:00:00.000Z' } },
      { headers: { 'set-cookie': setCookieCombined } }
    )
    Object.defineProperty(refreshResponse, 'headers', {
      value: {
        get: (name: string) => (name === 'set-cookie' ? setCookieCombined : null),
      },
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'unauthorized', message: 'Unauthorized' }, { status: 401 })
      )
      .mockResolvedValueOnce(refreshResponse)
      .mockResolvedValueOnce(jsonResponse({ data: authUser }))
    const forwardedCookies: string[] = []

    const result = await resolveAuthContext({
      fetchFn,
      cookieHeader: 'access-token=old-access; refresh-token=old-refresh',
      forwardSetCookie: (value) => forwardedCookies.push(value),
    })

    expect(result).toEqual({ status: 'authenticated', user: authUser })
    expect(forwardedCookies).toEqual([
      'access-token=new-access; HttpOnly; Path=/',
      'refresh-token=new-refresh; HttpOnly; Path=/',
    ])
  })

  it('reports an auth API transport failure as unavailable instead of throwing (68-27)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('API unavailable'))

    await expect(
      resolveAuthContext({
        fetchFn,
        cookieHeader: 'access-token=old-access; refresh-token=old-refresh',
      })
    ).resolves.toEqual({ status: 'unavailable', category: 'transport' })
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
  })

  it.each([403, 404, 400])(
    'keeps a non-retryable %i from /auth/me unauthenticated',
    async (status) => {
      await expect(
        resolveAuthContext({
          fetchFn: vi.fn().mockResolvedValue(jsonResponse({}, { status })),
          cookieHeader: 'refresh-token=refresh',
        })
      ).resolves.toEqual({ status: 'unauthenticated' })
    }
  )

  it.each([
    [429, 'rate_limited'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
  ])(
    'reports /auth/me %i as unavailable (%s), never as signed out (68-27)',
    async (status, category) => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, { status }))
      await expect(
        resolveAuthContext({ fetchFn, cookieHeader: 'access-token=a; refresh-token=refresh' })
      ).resolves.toEqual({ status: 'unavailable', category })
      // No refresh attempt: a 429/5xx says nothing about the session.
      expect(fetchFn).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['120', '120'],
    ['0', undefined],
    ['-5', undefined],
    ['abc', undefined],
    ['99999999', undefined],
    ['1e3', undefined],
    ['120, 130', undefined],
    ['Wed, 21 Oct 2015 07:28:00 GMT', undefined],
  ])('sanitizes Retry-After %j to %j', async (header, expected) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': header } }))
    const result = await resolveAuthContext({ fetchFn, cookieHeader: null })
    expect(result).toEqual({
      status: 'unavailable',
      category: 'rate_limited',
      ...(expected === undefined ? {} : { retryAfter: expected }),
    })
  })

  it('passes a sanitized Retry-After on a 5xx too', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, { status: 503, headers: { 'retry-after': '30' } }))
    await expect(resolveAuthContext({ fetchFn, cookieHeader: null })).resolves.toEqual({
      status: 'unavailable',
      category: 'upstream_error',
      retryAfter: '30',
    })
  })

  it('passes a future HTTP-date Retry-After through (within 24 h)', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString()
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': date } }))
    await expect(resolveAuthContext({ fetchFn, cookieHeader: null })).resolves.toEqual({
      status: 'unavailable',
      category: 'rate_limited',
      retryAfter: date,
    })
  })

  it('maps refresh network failure to unavailable, not session-expired (68-27)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockRejectedValueOnce(new Error('offline'))
    await expect(
      resolveAuthContext({ fetchFn, cookieHeader: 'refresh-token=refresh' })
    ).resolves.toEqual({ status: 'unavailable', category: 'transport' })
  })

  it.each([401, 403])('maps a rejected refresh (%i) to session-expired', async (status) => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({}, { status }))
    await expect(
      resolveAuthContext({ fetchFn, cookieHeader: 'refresh-token=refresh' })
    ).resolves.toEqual({ status: 'unauthenticated', reason: 'session-expired' })
  })

  it.each([
    [429, 'rate_limited'],
    [500, 'upstream_error'],
    [503, 'upstream_error'],
    [400, 'upstream_error'],
  ])(
    'maps an unavailable refresh (%i) to unavailable without a redirect reason',
    async (status, category) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({}, { status }))
      await expect(
        resolveAuthContext({ fetchFn, cookieHeader: 'refresh-token=refresh' })
      ).resolves.toEqual({ status: 'unavailable', category })
    }
  )

  it('still forwards rotated cookies when the post-refresh /auth/me is unavailable', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse({ data: {} }, { headers: { 'set-cookie': 'refresh-token=rotated; Path=/' } })
      )
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '7' } }))
    const forwarded: string[] = []
    await expect(
      resolveAuthContext({
        fetchFn,
        cookieHeader: 'refresh-token=refresh',
        forwardSetCookie: (value) => forwarded.push(value),
      })
    ).resolves.toEqual({ status: 'unavailable', category: 'rate_limited', retryAfter: '7' })
    expect(forwarded).toEqual(['refresh-token=rotated; Path=/'])
  })

  it.each([
    [
      'retry network failure',
      new Error('offline'),
      { status: 'unavailable', category: 'transport' },
    ],
    [
      'retry 429',
      jsonResponse({}, { status: 429 }),
      { status: 'unavailable', category: 'rate_limited' },
    ],
    [
      'retry 502',
      jsonResponse({}, { status: 502 }),
      { status: 'unavailable', category: 'upstream_error' },
    ],
  ])(
    'maps %s after a successful refresh to unavailable (68-27)',
    async (_label, retryResult, expected) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ data: {} }))
      if (retryResult instanceof Error) fetchFn.mockRejectedValueOnce(retryResult)
      else fetchFn.mockResolvedValueOnce(retryResult)
      await expect(
        resolveAuthContext({ fetchFn, cookieHeader: 'access-token=old; refresh-token=refresh' })
      ).resolves.toEqual(expected)
    }
  )

  it.each([
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
    for (const prefix of ['/projects', '/credentials', '/alerts', '/health', '/notifications']) {
      expect(isProtectedAppPath(prefix)).toBe(true)
      expect(isProtectedAppPath(`${prefix}/child`)).toBe(true)
    }
    expect(isProtectedAppPath('/project')).toBe(false)
    expect(isProtectedAppPath('/login')).toBe(false)
    // Lookalike guard for the newly added /notifications prefix specifically — a path that merely
    // starts with the same characters (not a real sub-path) must not match.
    expect(isProtectedAppPath('/notifications-archive')).toBe(false)
  })

  it('AC1 (Story 25.1): /extensions/panels and its slot sub-paths are protected', () => {
    expect(isProtectedAppPath('/extensions/panels')).toBe(true)
    expect(isProtectedAppPath('/extensions/panels/group')).toBe(true)
    // Lookalike guard — a path merely starting with the same characters must not match.
    expect(isProtectedAppPath('/extensions/panels-lookalike')).toBe(false)
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
