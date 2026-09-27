import { describe, expect, it, vi, beforeEach } from 'vitest'

const proxyApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/api-proxy.js', () => ({
  proxyApiRequest: proxyApiRequestMock,
}))

vi.mock('$env/dynamic/private', () => ({
  env: { API_BASE_URL: 'http://localhost:3000' },
}))

vi.mock('$app/environment', () => ({ dev: true }))

import { load } from './+page.server.js'

const HANDOFF_COOKIE_NAME = 'handoff-confirm'

function makeEvent(query: string) {
  const url = new URL(`http://localhost/handoff${query}`)
  const setCookie = vi.fn()
  return {
    event: {
      url,
      cookies: {
        set: setCookie,
        get: vi.fn(),
        getAll: vi.fn(),
        delete: vi.fn(),
        serialize: vi.fn(),
      },
    },
    setCookie,
  }
}

function jsonResponse(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Story 60.3 AC3/AC6: the claim-exchange `load` — consumes `?pendingId=...&claim=...` via
// apps/api's new exchange-claim endpoint (proxied, matching the existing prepare/+server.ts
// pattern), and sets the `handoff-confirm` cookie itself on success so the same-origin confirm
// POST that follows (unchanged) finds it.
describe('/handoff +page.server.ts load (Story 60.3)', () => {
  beforeEach(() => {
    proxyApiRequestMock.mockReset()
  })

  it('does nothing when pendingId or claim is missing from the URL (no claim to exchange)', async () => {
    const { event, setCookie } = makeEvent('?pendingId=abc')
    await load(event as never)

    expect(proxyApiRequestMock).not.toHaveBeenCalled()
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('does nothing when the URL has neither param at all', async () => {
    const { event, setCookie } = makeEvent('')
    await load(event as never)

    expect(proxyApiRequestMock).not.toHaveBeenCalled()
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('happy path: exchanges the claim and sets the handoff-confirm cookie with the remaining TTL, httpOnly + sameSite strict', async () => {
    const expiresAt = new Date(Date.now() + 45_000).toISOString()
    proxyApiRequestMock.mockResolvedValue(
      jsonResponse(200, { data: { rawCookieValue: 'fresh-raw-cookie', expiresAt } })
    )
    const { event, setCookie } = makeEvent('?pendingId=abc&claim=xyz')

    await load(event as never)

    expect(proxyApiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'auth/handoff/exchange-claim' })
    )
    expect(setCookie).toHaveBeenCalledWith(
      HANDOFF_COOKIE_NAME,
      'fresh-raw-cookie',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      })
    )
    const [, , options] = setCookie.mock.calls[0] as [string, string, { maxAge: number }]
    // Remaining TTL (~45s), NOT a fresh 120s.
    expect(options.maxAge).toBeGreaterThan(0)
    expect(options.maxAge).toBeLessThanOrEqual(45)
  })

  it('replay/generic rejection: a non-2xx exchange response never sets a cookie', async () => {
    proxyApiRequestMock.mockResolvedValue(
      jsonResponse(401, { code: 'handoff_rejected', message: 'Sign-in could not be verified.' })
    )
    const { event, setCookie } = makeEvent('?pendingId=abc&claim=xyz')

    await load(event as never)

    expect(setCookie).not.toHaveBeenCalled()
  })

  it('never sets a cookie if the exchange response is malformed (no rawCookieValue/expiresAt)', async () => {
    proxyApiRequestMock.mockResolvedValue(jsonResponse(200, { data: {} }))
    const { event, setCookie } = makeEvent('?pendingId=abc&claim=xyz')

    await load(event as never)

    expect(setCookie).not.toHaveBeenCalled()
  })

  it('never throws and never sets a cookie if the proxy fetch itself fails', async () => {
    proxyApiRequestMock.mockRejectedValue(new Error('network down'))
    const { event, setCookie } = makeEvent('?pendingId=abc&claim=xyz')

    await expect(load(event as never)).resolves.toBeDefined()
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('never sets a cookie for an already-expired remaining TTL', async () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString()
    proxyApiRequestMock.mockResolvedValue(
      jsonResponse(200, { data: { rawCookieValue: 'fresh-raw-cookie', expiresAt } })
    )
    const { event, setCookie } = makeEvent('?pendingId=abc&claim=xyz')

    await load(event as never)

    expect(setCookie).not.toHaveBeenCalled()
  })
})
