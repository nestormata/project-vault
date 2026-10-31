import { beforeEach, describe, expect, it, vi } from 'vitest'

const proxyApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/api-proxy.js', () => ({
  proxyApiRequest: proxyApiRequestMock,
}))

vi.mock('$env/dynamic/private', () => ({
  env: { API_BASE_URL: 'http://localhost:3000' },
}))

import { POST } from './+server.js'
// Routing precedence: this static route must win over the `[...path]` catch-all, which would
// forward the browser's cookies and body verbatim instead of the cookie's nonce.
import { POST as catchAllPost } from '../../../[...path]/+server.js'

const WEB_ORIGIN = 'http://localhost:5173'
const NONCE = 'n'.repeat(43)
const COOKIE_NAME = '__Host-pv-handoff-nonce'

type EventOptions = { headers?: Record<string, string>; body?: string; cookie?: string }

function makeEvent({ headers = {}, body = '{"token":"tok"}', cookie }: EventOptions = {}) {
  const deleteCookie = vi.fn()
  const event = {
    url: new URL(`${WEB_ORIGIN}/api/v1/auth/handoff/claim`),
    request: new Request(`${WEB_ORIGIN}/api/v1/auth/handoff/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
    cookies: {
      get: vi.fn((name: string) => (name === COOKIE_NAME ? cookie : undefined)),
      delete: deleteCookie,
      set: vi.fn(),
      getAll: vi.fn(),
      serialize: vi.fn(),
    },
  }
  return { event: event as unknown as Parameters<typeof POST>[0], deleteCookie }
}

function forwardedRequest(): Request {
  const [options] = proxyApiRequestMock.mock.calls[0] as [{ request: Request; path: string }]
  expect(options.path).toBe('auth/handoff/claim')
  return options.request
}

async function forwardedBody(): Promise<Record<string, unknown>> {
  return (await forwardedRequest().clone().json()) as Record<string, unknown>
}

const EXPECTED_DELETE = [COOKIE_NAME, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' }]

describe('POST /api/v1/auth/handoff/claim (Story 73.1 AC2-AC5)', () => {
  beforeEach(() => {
    proxyApiRequestMock.mockReset()
    proxyApiRequestMock.mockResolvedValue(
      Response.json({ code: 'handoff_rejected', message: 'x' }, { status: 401 })
    )
  })

  it('is a dedicated route, not the catch-all proxy', () => {
    expect(POST).not.toBe(catchAllPost)
  })

  it('forwards the token and the cookie nonce, deletes the cookie and relays every Set-Cookie', async () => {
    const apiHeaders = new Headers({ 'content-type': 'application/json' })
    apiHeaders.append('set-cookie', 'pv_access=a; Path=/; HttpOnly')
    apiHeaders.append('set-cookie', 'pv_refresh=r; Path=/; HttpOnly')
    proxyApiRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { userId: 'u1' } }), { status: 200, headers: apiHeaders })
    )
    const { event, deleteCookie } = makeEvent({
      cookie: NONCE,
      headers: { 'sec-fetch-site': 'same-origin', origin: WEB_ORIGIN, 'user-agent': 'browser-ua' },
    })

    const response = await POST(event)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { userId: 'u1' } })
    expect(response.headers.getSetCookie()).toEqual([
      'pv_access=a; Path=/; HttpOnly',
      'pv_refresh=r; Path=/; HttpOnly',
    ])
    expect(deleteCookie).toHaveBeenCalledWith(...EXPECTED_DELETE)
    expect(await forwardedBody()).toEqual({ token: 'tok', nonce: NONCE })
    const request = forwardedRequest()
    expect(request.headers.get('user-agent')).toBe('browser-ua')
    expect(request.headers.get('cookie')).toBeNull()
  })

  it('forwards nonce null when the browser has no nonce cookie, so the api records it', async () => {
    const { event, deleteCookie } = makeEvent({ headers: { 'sec-fetch-site': 'same-origin' } })

    const response = await POST(event)

    expect(response.status).toBe(401)
    expect(await forwardedBody()).toEqual({ token: 'tok', nonce: null })
    expect(deleteCookie).toHaveBeenCalledWith(...EXPECTED_DELETE)
  })

  it.each([
    ['a non-JSON body', 'not json'],
    ['a non-string token', '{"token":42}'],
    ['no token', '{}'],
  ])(
    'forwards an empty token for %s so the api still consumes the nonce and records it',
    async (_label, body) => {
      const { event } = makeEvent({ cookie: NONCE, body })
      await POST(event)
      expect(await forwardedBody()).toEqual({ token: '', nonce: NONCE })
    }
  )

  it.each([
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site' }],
    ['a foreign Origin', { origin: 'http://127.0.0.1:48999' }],
    ['Origin null', { origin: 'null' }],
  ])(
    'rejects %s with 403 before reaching the api and leaves the cookie alone',
    async (_label, headers) => {
      const { event, deleteCookie } = makeEvent({ cookie: NONCE, headers })

      const response = await POST(event)

      expect(response.status).toBe(403)
      expect(proxyApiRequestMock).not.toHaveBeenCalled()
      expect(deleteCookie).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['Sec-Fetch-Site none', { 'sec-fetch-site': 'none' }],
    ['no fetch metadata at all', {}],
  ])('accepts %s', async (_label, headers) => {
    const { event } = makeEvent({ cookie: NONCE, headers })
    await POST(event)
    expect(proxyApiRequestMock).toHaveBeenCalledTimes(1)
  })

  it('relays an api 503 as is', async () => {
    proxyApiRequestMock.mockResolvedValue(Response.json({ status: 'unavailable' }, { status: 503 }))
    const { event } = makeEvent({ cookie: NONCE })
    expect((await POST(event)).status).toBe(503)
  })
})
