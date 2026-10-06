import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, fetchWithSessionRefresh, isRefreshableAccessCode } from './client.js'
import { jsonResponse } from '$lib/test/json-response.js'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$app/navigation', () => ({ goto: gotoMock }))

describe('apiFetch', () => {
  beforeEach(() => {
    gotoMock.mockClear()
  })

  it.each(['access_token_missing', 'access_token_invalid', 'session_revoked'] as const)(
    'refreshes an expired access session once for %s before retrying the original request',
    async (code) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ code, message: 'Access token is invalid' }, { status: 401 })
        )
        .mockResolvedValueOnce(jsonResponse({ data: { expiresAt: '2026-08-08T02:00:00.000Z' } }))
        .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))

      await apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', {
        method: 'POST',
        body: JSON.stringify({ name: 'Custom', template: 'custom', fields: [] }),
      })

      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        '/api/v1/auth/refresh',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
      expect(fetchFn).toHaveBeenNthCalledWith(
        3,
        '/api/v1/projects/project-1/credentials',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
      // A successful refresh-and-retry is not a session expiry — no reason to redirect.
      expect(gotoMock).not.toHaveBeenCalled()
    }
  )

  // Regression guard: fast navigation fires several concurrent SvelteKit __data.json requests.
  // If one of them wins a refresh-token rotation first, a sibling request still holding the
  // now-revoked access token gets `session_revoked` from the server. Before this fix, that code
  // wasn't retried and surfaced as a false "your session expired" sign-out.
  it('recovers from session_revoked by refreshing and retrying, instead of surfacing a sign-out', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'session_revoked', message: 'Session has been revoked' },
          { status: 401 }
        )
      )
      .mockResolvedValueOnce(jsonResponse({ data: { expiresAt: '2026-08-08T02:00:00.000Z' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))

    await expect(
      apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'GET' })
    ).resolves.toEqual({ ok: true })

    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      '/api/v1/auth/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    )
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('shares one refresh request between concurrent expired API calls', async () => {
    let originalCalls = 0
    let refreshCalls = 0
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const fetchFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/refresh') {
        refreshCalls += 1
        await refreshGate
        return jsonResponse({ data: { expiresAt: '2026-08-08T02:00:00.000Z' } })
      }
      originalCalls += 1
      if (originalCalls <= 2) {
        return jsonResponse(
          { code: 'access_token_missing', message: 'Access token is missing' },
          { status: 401 }
        )
      }
      return jsonResponse({ data: { ok: true } })
    })

    const first = apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'GET' })
    await vi.waitFor(() => expect(refreshCalls).toBe(1))
    const second = apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'GET' })
    await vi.waitFor(() => expect(originalCalls).toBe(2))
    releaseRefresh()

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }])
    expect(refreshCalls).toBe(1)
    expect(originalCalls).toBe(4)
  })

  it('does not retry unrelated 401 responses', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'step_up_required', message: 'Step-up authentication required' },
          { status: 401 }
        )
      )

    await expect(
      apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'POST', body: '{}' })
    ).rejects.toThrow('Step-up authentication required')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // Not a session-expiry case at all — no reason to bounce the user to /login.
    expect(gotoMock).not.toHaveBeenCalled()
  })

  // Bug fix: a genuinely expired session used to just throw, leaving the page stuck (a swallowed
  // error, or the generic +error.svelte boundary) with no way back in short of a manual reload.
  it('redirects to /login when the session is genuinely expired and refresh fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'access_token_invalid', message: 'Access token is invalid' },
          { status: 401 }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'refresh_token_invalid', message: 'Refresh token is invalid' },
          { status: 401 }
        )
      )

    await expect(
      apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'GET' })
    ).rejects.toThrow('Access token is invalid')

    expect(gotoMock).toHaveBeenCalledWith('/login?reason=session-expired')
  })

  it('does not retry when the refresh request fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'access_token_missing', message: 'Access token is missing' },
          { status: 401 }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'refresh_token_invalid', message: 'Refresh token is invalid' },
          { status: 401 }
        )
      )

    await expect(
      apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'POST', body: '{}' })
    ).rejects.toThrow('Access token is missing')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  // Distinct from the `session_revoked` happy-path test above: a session that was genuinely
  // revoked (logout elsewhere, admin action) rather than merely raced by a concurrent rotation
  // must still surface as a real error, not retry-loop or get silently swallowed.
  it('does not mask a genuinely dead session behind session_revoked when the refresh also fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'session_revoked', message: 'Session has been revoked' },
          { status: 401 }
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { code: 'refresh_token_invalid', message: 'Refresh token is invalid' },
          { status: 401 }
        )
      )

    await expect(
      apiFetch(fetchFn, '/api/v1/projects/project-1/credentials', { method: 'POST', body: '{}' })
    ).rejects.toThrow('Session has been revoked')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('sends Content-Type: application/json when a body is present', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, '/api/v1/example', { method: 'POST', body: JSON.stringify({ a: 1 }) })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/example', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
  })

  // Regression guard: Fastify's default JSON body parser rejects a request that declares
  // `Content-Type: application/json` but sends no body at all — "Body cannot be empty when
  // content-type is set to 'application/json'" (FST_ERR_CTP_EMPTY_JSON_BODY). Every bodyless POST
  // helper (logout, refreshSession, enrollMfa, ...) was unconditionally sending that header,
  // so every one of those calls 400'd against the real API despite passing in mocked-fetch tests.
  it('omits Content-Type when there is no body, so bodyless POSTs do not 400 against a real JSON body parser', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, '/api/v1/example', { method: 'POST' })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/example', {
      method: 'POST',
      credentials: 'include',
      headers: {},
    })
  })

  it('still lets a caller override headers explicitly even without a body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, '/api/v1/example', {
      method: 'POST',
      headers: { 'x-vault-bootstrap-token': 'abc' },
    })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/example', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-vault-bootstrap-token': 'abc' },
    })
  })
})

// Story 61.1 — the raw-Response sibling of apiFetch's refresh-on-401, used by callers (the
// extension panel action dispatcher) that must read a non-envelope body and handle non-2xx
// responses themselves.
describe('fetchWithSessionRefresh', () => {
  const ACTION_URL = '/api/v1/extensions/panels/group/actions'
  const REFRESH_OK = () => jsonResponse({ data: { expiresAt: '2026-09-26T02:00:00.000Z' } })

  // Waits for redirectToSessionExpired()'s `goto(...).then(reset, reset)` latch to settle so the
  // next test's own redirect is never swallowed by a still-latched flag (module-level state).
  async function settleRedirectLatch() {
    await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    gotoMock.mockClear()
  })

  it.each(['access_token_missing', 'access_token_invalid', 'session_revoked'] as const)(
    'refreshes once on a %s 401 and retries the original request exactly once',
    async (code) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ code }, { status: 401 }))
        .mockResolvedValueOnce(REFRESH_OK())
        .mockResolvedValueOnce(jsonResponse({ html: '<p>done</p>' }))

      const result = await fetchWithSessionRefresh(fetchFn, ACTION_URL, () => ({
        method: 'POST',
        body: '{"kind":"x"}',
      }))

      expect(fetchFn).toHaveBeenCalledTimes(3)
      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        '/api/v1/auth/refresh',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
      expect(fetchFn).toHaveBeenNthCalledWith(3, ACTION_URL, {
        method: 'POST',
        body: '{"kind":"x"}',
      })
      expect(result.kind).toBe('response')
      if (result.kind !== 'response') throw new Error('unreachable')
      expect(result.response.status).toBe(200)
      await expect(result.response.json()).resolves.toEqual({ html: '<p>done</p>' })
      expect(gotoMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      'a non-refreshable 401 code',
      () => jsonResponse({ code: 'mfa_step_up_required' }, { status: 401 }),
    ],
    ['a 401 with no code', () => jsonResponse({ message: 'nope' }, { status: 401 })],
    ['a non-JSON 401 body', () => new Response('<html>401</html>', { status: 401 })],
    ['403 csrf_rejected', () => jsonResponse({ code: 'csrf_rejected' }, { status: 403 })],
    [
      '429 with a refreshable-looking code',
      () => jsonResponse({ code: 'access_token_missing' }, { status: 429 }),
    ],
    ['500', () => jsonResponse({ code: 'internal_error' }, { status: 500 })],
  ])('returns %s untouched (body unread) with no refresh and no retry', async (_label, make) => {
    const first = make()
    const fetchFn = vi.fn().mockResolvedValueOnce(first)

    const result = await fetchWithSessionRefresh(fetchFn, ACTION_URL, () => ({ method: 'POST' }))

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: 'response', response: first })
    expect(first.bodyUsed).toBe(false)
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('builds a fresh RequestInit per attempt via the buildInit factory, passed through unchanged', async () => {
    let csrf = 'old'
    const fetchFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/v1/auth/refresh') {
        csrf = 'new'
        return REFRESH_OK()
      }
      return fetchFn.mock.calls.length === 1
        ? jsonResponse({ code: 'access_token_missing' }, { status: 401 })
        : jsonResponse({ message: 'Saved' })
    })
    const buildInit = vi.fn(() => ({
      method: 'POST',
      credentials: 'same-origin' as const,
      headers: { 'x-csrf-token': csrf },
    }))

    await fetchWithSessionRefresh(fetchFn, ACTION_URL, buildInit)

    expect(buildInit).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0]?.[1]).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': 'old' },
    })
    expect(fetchFn.mock.calls[2]?.[1]).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': 'new' },
    })
  })

  it('returns a second 401 after a successful refresh as-is: no second refresh, no redirect', async () => {
    const retry401 = jsonResponse({ code: 'access_token_missing' }, { status: 401 })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'access_token_missing' }, { status: 401 }))
      .mockResolvedValueOnce(REFRESH_OK())
      .mockResolvedValueOnce(retry401)

    const result = await fetchWithSessionRefresh(fetchFn, ACTION_URL, () => ({ method: 'POST' }))

    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ kind: 'response', response: retry401 })
    expect(retry401.bodyUsed).toBe(false)
    expect(gotoMock).not.toHaveBeenCalled()
  })

  // A network-level refresh rejection no longer redirects (Story 61.3): see the
  // 'refresh outcome classification' suite below.
  it('returns session_expired and redirects once on a 401 refresh, without retrying', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'access_token_invalid' }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ code: 'refresh_token_missing' }, { status: 401 }))

    const result = await fetchWithSessionRefresh(fetchFn, ACTION_URL, () => ({ method: 'POST' }))

    expect(result).toEqual({ kind: 'session_expired' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(gotoMock).toHaveBeenCalledTimes(1)
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=session-expired')
    await settleRedirectLatch()
  })

  it('does not swallow a rejection of the retried request (E9)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'access_token_missing' }, { status: 401 }))
      .mockResolvedValueOnce(REFRESH_OK())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(
      fetchWithSessionRefresh(fetchFn, ACTION_URL, () => ({ method: 'POST' }))
    ).rejects.toThrow('Failed to fetch')
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('isRefreshableAccessCode only accepts a 401 with one of the three refreshable codes', () => {
    expect(isRefreshableAccessCode(401, 'access_token_missing')).toBe(true)
    expect(isRefreshableAccessCode(401, 'access_token_invalid')).toBe(true)
    expect(isRefreshableAccessCode(401, 'session_revoked')).toBe(true)
    expect(isRefreshableAccessCode(401, 'mfa_step_up_required')).toBe(false)
    expect(isRefreshableAccessCode(401, undefined)).toBe(false)
    expect(isRefreshableAccessCode(403, 'access_token_missing')).toBe(false)
  })
})

// Story 61.3 — the refresh outcome is tri-state: only a server rejection (401/403) is a dead
// session. A network error, an abort or any other answer leaves the session state unknown, so the
// user stays signed in and the original error / response is surfaced instead of a redirect.
describe('refresh outcome classification (Story 61.3)', () => {
  const PATH = '/api/v1/projects/project-1/credentials'
  const REFRESH_URL = '/api/v1/auth/refresh'
  const REFRESH_OK = () => jsonResponse({ data: { expiresAt: '2026-10-06T02:00:00.000Z' } })
  const missing401 = () =>
    jsonResponse(
      { code: 'access_token_missing', message: 'Access token is missing' },
      { status: 401 }
    )

  const unavailableRefreshes: Array<[string, () => Promise<Response>]> = [
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['an abort', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['a 500', async () => jsonResponse({ code: 'internal_error' }, { status: 500 })],
    ['a 503 vault sealed', async () => jsonResponse({ status: 'sealed' }, { status: 503 })],
    ['a 429', async () => jsonResponse({ code: 'rate_limited' }, { status: 429 })],
    ['a 400', async () => jsonResponse({ code: 'bad_request' }, { status: 400 })],
    ['a 200 with a non-JSON body', async () => new Response('<html>', { status: 200 })],
  ]

  // Waits for redirectToSessionExpired()'s `goto(...).then(reset, reset)` latch (module-level).
  async function settleRedirectLatch() {
    await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    gotoMock.mockClear()
  })

  it('apiFetch: a caller aborted while the refresh was unavailable rejects with its own abort', async () => {
    const controller = new AbortController()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing401())
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.reject(new TypeError('Failed to fetch'))
      })

    await expect(
      apiFetch(fetchFn, PATH, { method: 'GET', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it.each(unavailableRefreshes)(
    'apiFetch: %s during refresh keeps the user signed in and throws the original 401',
    async (_label, refresh) => {
      const fetchFn = vi.fn().mockResolvedValueOnce(missing401()).mockImplementationOnce(refresh)

      await expect(apiFetch(fetchFn, PATH, { method: 'GET' })).rejects.toMatchObject({
        name: 'ApiClientError',
        status: 401,
        code: 'access_token_missing',
      })

      expect(gotoMock).not.toHaveBeenCalled()
      expect(fetchFn).toHaveBeenCalledTimes(2)
    }
  )

  it.each(unavailableRefreshes)(
    'fetchWithSessionRefresh: %s during refresh returns the original 401 with a readable body',
    async (_label, refresh) => {
      const fetchFn = vi.fn().mockResolvedValueOnce(missing401()).mockImplementationOnce(refresh)

      const result = await fetchWithSessionRefresh(fetchFn, PATH, () => ({ method: 'POST' }))

      expect(result.kind).toBe('response')
      if (result.kind !== 'response') throw new Error('unreachable')
      expect(result.response.status).toBe(401)
      await expect(result.response.json()).resolves.toMatchObject({ code: 'access_token_missing' })
      expect(gotoMock).not.toHaveBeenCalled()
      expect(fetchFn).toHaveBeenCalledTimes(2)
    }
  )

  it.each([401, 403])(
    'apiFetch: a %s from the refresh endpoint redirects to login',
    async (status) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(missing401())
        .mockResolvedValueOnce(jsonResponse({ code: 'refresh_token_invalid' }, { status }))

      await expect(apiFetch(fetchFn, PATH, { method: 'GET' })).rejects.toThrow(
        'Access token is missing'
      )

      await settleRedirectLatch()
      expect(gotoMock).toHaveBeenCalledWith('/login?reason=session-expired')
    }
  )

  it('fetchWithSessionRefresh: a 403 from the refresh endpoint redirects and reports session_expired', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing401())
      .mockResolvedValueOnce(jsonResponse({ code: 'forbidden' }, { status: 403 }))

    await expect(
      fetchWithSessionRefresh(fetchFn, PATH, () => ({ method: 'POST' }))
    ).resolves.toEqual({ kind: 'session_expired' })

    await settleRedirectLatch()
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=session-expired')
  })

  it('never forwards the caller signal into the shared refresh request', async () => {
    const controller = new AbortController()
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(missing401())
      .mockResolvedValueOnce(REFRESH_OK())
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, PATH, { method: 'GET', signal: controller.signal })

    expect(fetchFn.mock.calls[0]?.[1]).toHaveProperty('signal', controller.signal)
    expect(fetchFn.mock.calls[1]?.[0]).toBe(REFRESH_URL)
    expect(fetchFn.mock.calls[1]?.[1]).not.toHaveProperty('signal')
  })

  it('a first caller aborting mid-refresh does not fail the joiner: one refresh, joiner succeeds, no redirect', async () => {
    const controller = new AbortController()
    let finishRefresh: (response: Response) => void = () => {}
    const refreshPending = new Promise<Response>((resolve) => {
      finishRefresh = resolve
    })
    let refreshCalls = 0
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input)
      if (target === REFRESH_URL) {
        refreshCalls += 1
        return refreshPending
      }
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (fetchFn.mock.calls.filter(([url]) => url !== REFRESH_URL).length <= 2) return missing401()
      return jsonResponse({ data: { ok: true } })
    })

    const first = apiFetch(fetchFn, PATH, { method: 'GET', signal: controller.signal })
    const second = apiFetch(fetchFn, `${PATH}?b=1`, { method: 'GET' })
    const firstSettled = first.then(
      () => 'resolved',
      (error: unknown) => (error as Error).name
    )
    await vi.waitFor(() => expect(refreshCalls).toBe(1))
    controller.abort()
    finishRefresh(REFRESH_OK())

    await expect(second).resolves.toEqual({ ok: true })
    await expect(firstSettled).resolves.toBe('AbortError')
    expect(refreshCalls).toBe(1)
    expect(gotoMock).not.toHaveBeenCalled()
  })
})
