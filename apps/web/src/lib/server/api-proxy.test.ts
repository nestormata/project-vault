import { describe, expect, it, vi } from 'vitest'
import { proxyApiRequest, proxyReadyRequest } from './api-proxy.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('server API proxy', () => {
  it('forwards /api/v1 requests to the trusted API origin', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    const response = await proxyApiRequest({
      fetchFn,
      request: new Request('http://web.local/api/v1/auth/login?next=dashboard', {
        method: 'POST',
        headers: { cookie: 'refresh-token=opaque', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alex@example.com' }),
      }),
      apiBaseUrl: 'http://api.local:3000',
      path: 'auth/login',
    })

    const forwarded = fetchFn.mock.calls[0]?.[0] as Request
    expect(forwarded.url).toBe('http://api.local:3000/api/v1/auth/login?next=dashboard')
    expect(forwarded.method).toBe('POST')
    expect(forwarded.headers.get('cookie')).toBe('refresh-token=opaque')
    expect(forwarded.headers.get('content-type')).toBe('application/json')
    await expect(forwarded.text()).resolves.toBe(JSON.stringify({ email: 'alex@example.com' }))
    await expect(response.json()).resolves.toEqual({ data: { ok: true } })
  })

  it('defaults to the local API origin without using request-controlled input', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }))

    await proxyReadyRequest({
      fetchFn,
      request: new Request('http://web.local/ready?apiBaseUrl=https://attacker.example'),
      apiBaseUrl: '',
    })

    const forwarded = fetchFn.mock.calls[0]?.[0] as Request
    expect(forwarded.url).toBe('http://localhost:3000/ready?apiBaseUrl=https://attacker.example')
  })
})
