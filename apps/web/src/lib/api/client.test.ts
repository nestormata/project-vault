import { describe, expect, it, vi } from 'vitest'
import { apiFetch } from './client.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('apiFetch', () => {
  it.each(['access_token_missing', 'access_token_invalid'] as const)(
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
    }
  )

  it('shares one refresh request between concurrent expired API calls', async () => {
    let originalCalls = 0
    let refreshCalls = 0
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const fetchFn = vi.fn(async (path: string) => {
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
