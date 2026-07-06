import { describe, it, expect, vi } from 'vitest'
import {
  assertPublicHostname,
  buildPinnedLookupHandler,
  isPrivateIPv4,
  isPrivateIPv6,
  safeFetchExternal,
  UnsafeForwardingUrlError,
} from './safe-fetch.js'

const WEBHOOK_HOSTNAME_URL = 'https://webhook.example.com/'
const WEBHOOK_INGEST_URL = 'https://webhook.example.com/ingest'
const PUBLIC_IP = '93.184.216.34'
const PINNED_TEST_IP = '203.0.113.10'
const LINK_LOCAL_METADATA_IP = '169.254.169.254'
const POST_METHOD = 'POST'

describe('isPrivateIPv4 (D4)', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    [LINK_LOCAL_METADATA_IP, true],
    ['0.0.0.0', true],
    ['1.1.1.1', false],
    [PUBLIC_IP, false],
    ['172.32.0.1', false], // just outside 172.16.0.0/12
  ])('%s -> private=%s', (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected)
  })
})

describe('isPrivateIPv6 (D4)', () => {
  it.each([
    ['::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:10.0.0.5', true],
    ['2606:4700:4700::1111', false], // Cloudflare public IPv6
  ])('%s -> private=%s', (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected)
  })
})

describe('assertPublicHostname (AC-17)', () => {
  it('rejects a hostname resolving to loopback', async () => {
    await expect(assertPublicHostname('https://loopback.example.com')).rejects.toThrow(
      UnsafeForwardingUrlError
    )
  })

  it('rejects loopback/link-local/RFC1918 addresses via IP-literal hostnames', async () => {
    const cases = ['127.0.0.1', LINK_LOCAL_METADATA_IP, '10.0.0.5', '172.16.0.1', '192.168.1.1']
    for (const ip of cases) {
      await expect(assertPublicHostname(`https://${ip}/`)).rejects.toThrow(UnsafeForwardingUrlError)
    }
  })

  it('accepts a normal public IP-literal control case', async () => {
    await expect(assertPublicHostname('https://1.1.1.1/')).resolves.toBeUndefined()
  })

  it('rejects when the injected lookup resolves to a private address', async () => {
    await expect(
      assertPublicHostname(WEBHOOK_HOSTNAME_URL, () => Promise.resolve([{ address: '10.0.0.5' }]))
    ).rejects.toThrow(UnsafeForwardingUrlError)
  })

  it('accepts when the injected lookup resolves to a public address', async () => {
    await expect(
      assertPublicHostname(WEBHOOK_HOSTNAME_URL, () => Promise.resolve([{ address: PUBLIC_IP }]))
    ).resolves.toBeUndefined()
  })
})

describe('buildPinnedLookupHandler (DNS-rebinding correction)', () => {
  it('always returns the pinned addresses, ignoring the hostname/options undici passes', () => {
    const handler = buildPinnedLookupHandler([{ address: PUBLIC_IP }])
    const callback = vi.fn()

    handler('totally-different-hostname.example.com', {}, callback)

    expect(callback).toHaveBeenCalledWith(null, [{ address: PUBLIC_IP, family: 4 }])
  })

  it('never re-resolves even if called multiple times with different hostnames (rebinding proof)', () => {
    const handler = buildPinnedLookupHandler([{ address: PINNED_TEST_IP }])
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    handler('first-call-host', {}, firstCallback)
    handler('second-call-host-different', {}, secondCallback)

    expect(firstCallback).toHaveBeenCalledWith(null, [{ address: PINNED_TEST_IP, family: 4 }])
    expect(secondCallback).toHaveBeenCalledWith(null, [{ address: PINNED_TEST_IP, family: 4 }])
  })
})

describe('safeFetchExternal (AC-17/AC-18)', () => {
  it('rejects a non-https url before any DNS lookup or fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(
      safeFetchExternal('http://example.com/', { method: POST_METHOD }, { fetchImpl })
    ).rejects.toThrow(UnsafeForwardingUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects when DNS resolves to a private address, without calling fetch', async () => {
    const fetchImpl = vi.fn()
    const lookup = () => Promise.resolve([{ address: LINK_LOCAL_METADATA_IP }])
    await expect(
      safeFetchExternal(WEBHOOK_HOSTNAME_URL, { method: POST_METHOD }, { fetchImpl, lookup })
    ).rejects.toThrow(UnsafeForwardingUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('issues the request with redirect: manual and reports a 3xx as a non-ok delivery failure', async () => {
    const lookup = () => Promise.resolve([{ address: PUBLIC_IP }])
    const fetchImpl = vi.fn().mockResolvedValue({ status: 302, body: null })

    const result = await safeFetchExternal(
      WEBHOOK_INGEST_URL,
      { method: POST_METHOD, body: '{}' },
      { fetchImpl, lookup }
    )

    expect(result).toEqual({ status: 302, ok: false })
    expect(fetchImpl).toHaveBeenCalledWith(
      WEBHOOK_INGEST_URL,
      expect.objectContaining({ redirect: 'manual', method: POST_METHOD })
    )
  })

  it('reports a 2xx response as ok', async () => {
    const lookup = () => Promise.resolve([{ address: PUBLIC_IP }])
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, body: null })

    const result = await safeFetchExternal(
      WEBHOOK_INGEST_URL,
      { method: POST_METHOD },
      { fetchImpl, lookup }
    )

    expect(result).toEqual({ status: 200, ok: true })
  })

  it('reports a 5xx response as a delivery failure', async () => {
    const lookup = () => Promise.resolve([{ address: PUBLIC_IP }])
    const fetchImpl = vi.fn().mockResolvedValue({ status: 503, body: null })

    const result = await safeFetchExternal(
      WEBHOOK_INGEST_URL,
      { method: POST_METHOD },
      { fetchImpl, lookup }
    )

    expect(result).toEqual({ status: 503, ok: false })
  })
})
