import { describe, expect, it, vi, beforeEach } from 'vitest'

const proxyApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/api-proxy.js', () => ({
  proxyApiRequest: proxyApiRequestMock,
}))

// Mutable per test: load reads env per request (Story 60.4 AC3 — never cached at module level).
const envMock = vi.hoisted(() => ({
  API_BASE_URL: 'http://localhost:3000',
  VAULT_HANDOFF_ISSUER: undefined as string | undefined,
}))

vi.mock('$env/dynamic/private', () => ({
  env: envMock,
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
    envMock.VAULT_HANDOFF_ISSUER = undefined
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

// Story 60.4 AC3/AC6: load also returns the configured CentralizeMe origin for the consent page's
// "Return to CentralizeMe" link — from the web process's own VAULT_HANDOFF_ISSUER only, in EVERY
// branch (including the early returns), without touching the claim-exchange behaviour above.
describe('/handoff +page.server.ts load — centralizeMeOrigin (Story 60.4)', () => {
  beforeEach(() => {
    proxyApiRequestMock.mockReset()
    envMock.VAULT_HANDOFF_ISSUER = undefined
  })

  it.each([
    ['3.1 happy', 'https://app.centralizeme.com', 'https://app.centralizeme.com'],
    [
      '3.2 path stripped',
      'https://router.centralizeme.com/handoff/v1',
      'https://router.centralizeme.com',
    ],
    ['3.3 port kept', 'http://127.0.0.1:4173', 'http://127.0.0.1:4173'],
    ['3.4 unset', undefined, null],
    ['3.4 empty', '', null],
    ['3.4 whitespace', '   ', null],
    ['3.5 hostile scheme', 'javascript:alert(1)', null],
    ['3.6 non-URL issuer', 'centralizeme-router', null],
    ['3.7 credentials', 'https://user:pw@cm.example', null],
  ])('%s', async (_label, issuer, expected) => {
    envMock.VAULT_HANDOFF_ISSUER = issuer
    const { event } = makeEvent('')
    await expect(load(event as never)).resolves.toEqual({ centralizeMeOrigin: expected })
  })

  it('3.8: a returnTo query param never influences the origin', async () => {
    const { event } = makeEvent(
      '?returnTo=https%3A%2F%2Fevil.example&cmOrigin=https%3A%2F%2Fevil.example'
    )
    await expect(load(event as never)).resolves.toEqual({ centralizeMeOrigin: null })
  })

  it('resolves the env per request (a changed value is picked up without re-importing)', async () => {
    envMock.VAULT_HANDOFF_ISSUER = 'https://one.example'
    await expect(load(makeEvent('').event as never)).resolves.toEqual({
      centralizeMeOrigin: 'https://one.example',
    })
    envMock.VAULT_HANDOFF_ISSUER = 'https://two.example'
    await expect(load(makeEvent('').event as never)).resolves.toEqual({
      centralizeMeOrigin: 'https://two.example',
    })
  })

  describe('every exit path returns the key', () => {
    beforeEach(() => {
      envMock.VAULT_HANDOFF_ISSUER = 'https://app.centralizeme.com'
    })
    const expected = { centralizeMeOrigin: 'https://app.centralizeme.com' }

    it('missing claim (early return)', async () => {
      await expect(load(makeEvent('?pendingId=abc').event as never)).resolves.toEqual(expected)
    })

    it('proxy throws', async () => {
      proxyApiRequestMock.mockRejectedValue(new Error('network down'))
      await expect(load(makeEvent('?pendingId=abc&claim=xyz').event as never)).resolves.toEqual(
        expected
      )
    })

    it('non-2xx exchange', async () => {
      proxyApiRequestMock.mockResolvedValue(jsonResponse(401, { code: 'handoff_rejected' }))
      await expect(load(makeEvent('?pendingId=abc&claim=xyz').event as never)).resolves.toEqual(
        expected
      )
    })

    it('successful exchange (cookie still set exactly as before)', async () => {
      const expiresAt = new Date(Date.now() + 45_000).toISOString()
      proxyApiRequestMock.mockResolvedValue(
        jsonResponse(200, { data: { rawCookieValue: 'fresh-raw-cookie', expiresAt } })
      )
      const { event, setCookie } = makeEvent('?pendingId=abc&claim=xyz')
      await expect(load(event as never)).resolves.toEqual(expected)
      expect(setCookie).toHaveBeenCalledWith(
        HANDOFF_COOKIE_NAME,
        'fresh-raw-cookie',
        expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/' })
      )
    })
  })
})
