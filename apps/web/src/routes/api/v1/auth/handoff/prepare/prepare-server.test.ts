import { describe, expect, it, vi, beforeEach } from 'vitest'

const proxyApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/api-proxy.js', () => ({
  proxyApiRequest: proxyApiRequestMock,
}))

vi.mock('$env/dynamic/private', () => ({
  env: { CORS_ALLOWED_ORIGINS: 'https://cm.example, https://other-cm.example' },
}))

import { OPTIONS, POST } from './+server.js'
// AC3.13 regression: confirm SvelteKit's routing resolves this static route ahead of the
// `[...path]` catch-all — an unrelated proxied path must never pick up this route's CORS headers.
import { POST as catchAllPost } from '../../../[...path]/+server.js'

function makeRequestEvent(url: string, init: RequestInit & { headers?: HeadersInit } = {}) {
  const request = new Request(url, init)
  return { request } as unknown as Parameters<typeof POST>[0]
}

describe('/api/v1/auth/handoff/prepare +server.ts', () => {
  beforeEach(() => {
    proxyApiRequestMock.mockReset()
  })

  describe('OPTIONS preflight', () => {
    it('answers an allowed origin with CORS headers, never a wildcard', async () => {
      const response = await OPTIONS(
        makeRequestEvent('http://localhost/api/v1/auth/handoff/prepare', {
          method: 'OPTIONS',
          headers: { origin: 'https://cm.example' },
        })
      )

      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://cm.example')
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true')
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
      expect(proxyApiRequestMock).not.toHaveBeenCalled()
    })

    it('rejects an origin absent from the allowlist with no CORS headers at all', async () => {
      const response = await OPTIONS(
        makeRequestEvent('http://localhost/api/v1/auth/handoff/prepare', {
          method: 'OPTIONS',
          headers: { origin: 'https://attacker.example' },
        })
      )

      expect(response.status).toBe(403)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
  })

  describe('POST', () => {
    it('proxies to apps/api and adds CORS headers for an allowed origin (AC3.11)', async () => {
      proxyApiRequestMock.mockResolvedValue(
        new Response(JSON.stringify({ data: { pendingId: 'p1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const response = await POST(
        makeRequestEvent('http://localhost/api/v1/auth/handoff/prepare', {
          method: 'POST',
          headers: { origin: 'https://cm.example', 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'x' }),
        })
      )

      expect(proxyApiRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'auth/handoff/prepare' })
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://cm.example')
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    })

    // AC3.12: this story's chosen behavior — the CORS check short-circuits BEFORE proxying, so a
    // disallowed origin's request never even reaches apps/api.
    it('short-circuits before proxying for a disallowed origin (AC3.12)', async () => {
      const response = await POST(
        makeRequestEvent('http://localhost/api/v1/auth/handoff/prepare', {
          method: 'POST',
          headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'x' }),
        })
      )

      expect(response.status).toBe(403)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(proxyApiRequestMock).not.toHaveBeenCalled()
    })

    it('rejects a request with no Origin header at all', async () => {
      const response = await POST(
        makeRequestEvent('http://localhost/api/v1/auth/handoff/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'x' }),
        })
      )

      expect(response.status).toBe(403)
      expect(proxyApiRequestMock).not.toHaveBeenCalled()
    })
  })

  it('AC3.13: only the dedicated prepare route gets CORS headers, not an unrelated proxied path', async () => {
    proxyApiRequestMock.mockResolvedValue(new Response(null, { status: 200 }))

    const catchAllEvent = {
      params: { path: 'some/other/path' },
      request: new Request('http://localhost/api/v1/some/other/path', {
        method: 'POST',
        headers: { origin: 'https://cm.example' },
      }),
    } as unknown as Parameters<typeof catchAllPost>[0]

    const response = await catchAllPost(catchAllEvent)

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})
