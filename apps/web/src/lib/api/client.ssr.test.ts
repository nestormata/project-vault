import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { apiFetch } from './client.js'
import { jsonResponse } from '$lib/test/json-response.js'

// This file exercises apiFetch()'s SSR branch (`browser: false`). `$app/environment`'s `browser`
// export is a static import read at module load time, so it can't be toggled per-test within
// `client.test.ts` (which mocks it implicitly to `true` via jsdom/sveltekit's default) — hence a
// dedicated sibling file with its own file-scoped `vi.mock('$app/environment', ...)`, mirroring
// the pattern `client.test.ts` already uses for `vi.mock('$app/navigation', ...)`.
vi.mock('$app/environment', () => ({ browser: false }))

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$app/navigation', () => ({ goto: gotoMock }))

describe('apiFetch during SSR (browser: false)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
  })

  it.each(['access_token_missing', 'access_token_invalid', 'session_revoked'] as const)(
    'refreshes an expired access session once for %s before retrying the original request, same as the browser path',
    async (code) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ code, message: 'Access token is invalid' }, { status: 401 })
        )
        .mockResolvedValueOnce(jsonResponse({ data: { expiresAt: '2026-08-08T02:00:00.000Z' } }))
        .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))

      await expect(
        apiFetch(fetchFn, '/api/v1/projects/project-1/services', { method: 'GET' })
      ).resolves.toEqual({ ok: true })

      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        '/api/v1/auth/refresh',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
      expect(fetchFn).toHaveBeenNthCalledWith(
        3,
        '/api/v1/projects/project-1/services',
        expect.objectContaining({ method: 'GET', credentials: 'include' })
      )
      // The SSR path must never call the browser-only goto().
      expect(gotoMock).not.toHaveBeenCalled()
    }
  )

  it('throws SvelteKit redirect(303, "/login?reason=session-expired") when the refresh itself fails during SSR, and never calls goto()', async () => {
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

    let caught: unknown
    try {
      await apiFetch(fetchFn, '/api/v1/projects/project-1/services', { method: 'GET' })
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    expect(caught).toMatchObject({ status: 303, location: '/login?reason=session-expired' })
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it("keeps two concurrent SSR requests (simulating two different users) fully isolated: each refreshes and resolves with its own response, never the other user's", async () => {
    let userARefreshCalls = 0
    let userBRefreshCalls = 0

    const fetchFnUserA = vi.fn(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        userARefreshCalls += 1
        return jsonResponse({ data: { expiresAt: '2026-08-08T02:00:00.000Z' } })
      }
      if (fetchFnUserA.mock.calls.length <= 1) {
        return jsonResponse(
          { code: 'access_token_invalid', message: 'Access token is invalid' },
          { status: 401 }
        )
      }
      return jsonResponse({ data: { userId: 'user-a' } })
    })

    const fetchFnUserB = vi.fn(async (path: string) => {
      if (path === '/api/v1/auth/refresh') {
        userBRefreshCalls += 1
        return jsonResponse({ data: { expiresAt: '2026-08-08T02:00:00.000Z' } })
      }
      if (fetchFnUserB.mock.calls.length <= 1) {
        return jsonResponse(
          { code: 'access_token_missing', message: 'Access token is missing' },
          { status: 401 }
        )
      }
      return jsonResponse({ data: { userId: 'user-b' } })
    })

    const [resultA, resultB] = await Promise.all([
      apiFetch(fetchFnUserA, '/api/v1/projects/project-1/services', { method: 'GET' }),
      apiFetch(fetchFnUserB, '/api/v1/projects/project-2/services', { method: 'GET' }),
    ])

    expect(resultA).toEqual({ userId: 'user-a' })
    expect(resultB).toEqual({ userId: 'user-b' })
    // Each concurrent SSR request refreshed independently — no shared single-flight promise was
    // joined across the two "users", so both fetchFns saw their own dedicated refresh call.
    expect(userARefreshCalls).toBe(1)
    expect(userBRefreshCalls).toBe(1)
    // Neither user's fetchFn was ever called with the other user's request path.
    for (const call of fetchFnUserA.mock.calls) {
      expect(call[0]).not.toBe('/api/v1/projects/project-2/services')
    }
    for (const call of fetchFnUserB.mock.calls) {
      expect(call[0]).not.toBe('/api/v1/projects/project-1/services')
    }
  })
})
