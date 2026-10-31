import { beforeEach, describe, expect, it, vi } from 'vitest'

const proxyApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/api-proxy.js', () => ({
  proxyApiRequest: proxyApiRequestMock,
}))

vi.mock('$env/dynamic/private', () => ({
  env: { API_BASE_URL: 'http://localhost:3000' },
}))

import { GET } from './+server.js'

const NONCE = 'n'.repeat(43)
const REDIRECT_URL = `https://router.example/handoff/start?v=1&nonce=${NONCE}`

function startResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeEvent() {
  const set = vi.fn()
  const event = {
    request: new Request('http://localhost/auth/start', {
      headers: { 'user-agent': 'browser-ua', 'x-forwarded-for': '203.0.113.7' },
    }),
    cookies: { set, get: vi.fn(), getAll: vi.fn(), delete: vi.fn(), serialize: vi.fn() },
  }
  return { event: event as unknown as Parameters<typeof GET>[0], set }
}

async function redirectOf(
  promise: Promise<unknown>
): Promise<{ status: number; location: string }> {
  const thrown = await promise.then(
    () => {
      throw new Error('expected a redirect')
    },
    (error: unknown) => error as { status: number; location: string }
  )
  return { status: thrown.status, location: thrown.location }
}

describe('GET /auth/start (Story 73.1 AC1)', () => {
  beforeEach(() => {
    proxyApiRequestMock.mockReset()
  })

  it('sets the host-only nonce cookie and answers 303 to the issuer start URL', async () => {
    proxyApiRequestMock.mockResolvedValue(
      startResponse(200, {
        data: { nonce: NONCE, expiresAt: '2026-10-30T00:02:00.000Z', redirectUrl: REDIRECT_URL },
      })
    )
    const { event, set } = makeEvent()

    expect(await redirectOf(Promise.resolve().then(() => GET(event)))).toEqual({
      status: 303,
      location: REDIRECT_URL,
    })
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith('__Host-pv-handoff-nonce', NONCE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 120,
    })
  })

  it('calls the api start route server to server, forwarding the client identity headers', async () => {
    proxyApiRequestMock.mockResolvedValue(
      startResponse(200, { data: { nonce: NONCE, redirectUrl: REDIRECT_URL } })
    )
    const { event } = makeEvent()
    await redirectOf(Promise.resolve().then(() => GET(event)))

    const [options] = proxyApiRequestMock.mock.calls[0] as [
      { path: string; request: Request; apiBaseUrl: string },
    ]
    expect(options.path).toBe('auth/handoff/start')
    expect(options.apiBaseUrl).toBe('http://localhost:3000')
    expect(options.request.method).toBe('POST')
    expect(options.request.headers.get('user-agent')).toBe('browser-ua')
    expect(options.request.headers.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(options.request.headers.get('cookie')).toBeNull()
  })

  it.each([
    ['the api rejects (handoff disabled or start URL unset)', () => startResponse(401, {})],
    ['the api is unreachable', () => startResponse(503, { status: 'unavailable' })],
    ['the body has no nonce', () => startResponse(200, { data: { redirectUrl: REDIRECT_URL } })],
    [
      'the nonce is not base64url',
      () => startResponse(200, { data: { nonce: 'bad nonce;', redirectUrl: REDIRECT_URL } }),
    ],
    [
      'the redirect URL is relative',
      () => startResponse(200, { data: { nonce: NONCE, redirectUrl: '/elsewhere' } }),
    ],
    [
      'the redirect URL is not http(s)',
      () => startResponse(200, { data: { nonce: NONCE, redirectUrl: 'javascript:alert(1)' } }),
    ],
    ['the body is not JSON', () => new Response('nope', { status: 200 })],
  ])('sets no cookie and answers 303 to /auth/claim when %s', async (_label, response) => {
    proxyApiRequestMock.mockResolvedValue(response())
    const { event, set } = makeEvent()

    expect(await redirectOf(Promise.resolve().then(() => GET(event)))).toEqual({
      status: 303,
      location: '/auth/claim',
    })
    expect(set).not.toHaveBeenCalled()
  })

  it('sets no cookie and answers 303 to /auth/claim when the proxy throws', async () => {
    proxyApiRequestMock.mockRejectedValue(new Error('boom'))
    const { event, set } = makeEvent()

    expect((await redirectOf(Promise.resolve().then(() => GET(event)))).location).toBe(
      '/auth/claim'
    )
    expect(set).not.toHaveBeenCalled()
  })
})
