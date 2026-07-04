import { afterEach, describe, expect, it, vi } from 'vitest'

const lookupMock = vi.fn()
vi.mock('node:dns/promises', () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}))

const {
  assertUrlIsMonitorable,
  createSsrfSafeDispatcher,
  isPrivateOrReservedIp,
  redactUrlForDisplay,
  UrlNotMonitorableError,
} = await import('./url-safety.js')

afterEach(() => {
  lookupMock.mockReset()
})

describe('isPrivateOrReservedIp (Task 3 boundary list)', () => {
  it.each([
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.15.255.255', false], // just outside range — must be allowed
    ['172.32.0.0', false], // just outside range — must be allowed
    ['192.168.0.0', true],
    ['192.168.255.255', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true], // cloud metadata address
    ['169.254.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('IPv4 %s -> reserved=%s', (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected)
  })

  it.each([
    ['::1', true],
    ['fc00::1', true],
    ['fe80::1', true],
    ['2001:4860:4860::8888', false],
  ])('IPv6 %s -> reserved=%s', (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected)
  })

  it.each([
    ['::ffff:127.0.0.1', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:8.8.8.8', false],
  ])('IPv4-mapped IPv6 %s -> reserved=%s (adversarial-review finding 7)', (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected)
  })

  it.each([
    ['2130706433', true], // decimal encoding of 127.0.0.1
    ['0x7f000001', true], // hex encoding of 127.0.0.1
    ['017700000001', true], // octal encoding of 127.0.0.1
  ])(
    'rejects non-canonical numeric-literal encoding %s of 127.0.0.1 (adversarial-review finding 7)',
    (literal, expected) => {
      expect(isPrivateOrReservedIp(literal)).toBe(expected)
    }
  )

  it('does not treat an ordinary hostname string as a reserved IP', () => {
    expect(isPrivateOrReservedIp('example.com')).toBe(false)
  })
})

describe('assertUrlIsMonitorable (AC 1, AC 2)', () => {
  it('resolves for a public https URL', async () => {
    await expect(assertUrlIsMonitorable('https://8.8.8.8/health')).resolves.toBeUndefined()
  })

  it('rejects non-http/https schemes', async () => {
    await expect(assertUrlIsMonitorable('ftp://example.com/file')).rejects.toBeInstanceOf(
      UrlNotMonitorableError
    )
  })

  it('rejects a literal localhost hostname', async () => {
    await expect(assertUrlIsMonitorable('http://localhost/')).rejects.toBeInstanceOf(
      UrlNotMonitorableError
    )
  })

  it.each([
    'http://127.0.0.1/admin',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
  ])('rejects a literal private/loopback/link-local/metadata IP URL %s', async (url) => {
    await expect(assertUrlIsMonitorable(url)).rejects.toBeInstanceOf(UrlNotMonitorableError)
  })

  it.each([
    'http://2130706433/',
    'http://0x7f000001/',
    'http://017700000001/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects encoded/obfuscated IP literal %s (ADR-6.2-08)', async (url) => {
    await expect(assertUrlIsMonitorable(url)).rejects.toBeInstanceOf(UrlNotMonitorableError)
  })

  it('rejects when a hostname resolves to any private address among mixed answers', async () => {
    lookupMock.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    await expect(assertUrlIsMonitorable('http://mixed.example.com/')).rejects.toBeInstanceOf(
      UrlNotMonitorableError
    )
  })

  it('resolves when every resolved address is public', async () => {
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    await expect(assertUrlIsMonitorable('http://public.example.com/')).resolves.toBeUndefined()
  })
})

describe('redactUrlForDisplay (ADR-6.2-11)', () => {
  it('strips userinfo and masks deny-listed query params', () => {
    expect(
      redactUrlForDisplay('https://svc:hunter2@partner.example.com/ping?apikey=sk_live_abc123')
    ).toBe('https://partner.example.com/ping?apikey=***REDACTED***')
  })

  it.each(['apikey', 'api_key', 'token', 'secret', 'password', 'access_token', 'auth'])(
    'masks the %s query param case-insensitively, preserving the key',
    (key) => {
      const result = redactUrlForDisplay(`https://example.com/x?${key.toUpperCase()}=shh`)
      expect(result).toContain(`${key.toUpperCase()}=***REDACTED***`)
    }
  )

  it('leaves a plain URL with no userinfo/secret params unchanged', () => {
    expect(redactUrlForDisplay('https://api.example.com/health')).toBe(
      'https://api.example.com/health'
    )
  })

  it('leaves non-deny-listed query params untouched', () => {
    expect(redactUrlForDisplay('https://example.com/x?foo=bar')).toBe(
      'https://example.com/x?foo=bar'
    )
  })
})

describe('createSsrfSafeDispatcher (ADR-6.2-08 DNS-rebinding defense)', () => {
  it('rejects a connection whose freshly-resolved address is private (simulated rebinding target)', async () => {
    // A hostname that resolves, at connect time, to a loopback address — the dispatcher's own
    // connect-time re-validation must reject it, proving the check runs on every connection,
    // not just once at an earlier validation step.
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])

    const dispatcher = createSsrfSafeDispatcher()
    await expect(
      fetch('http://rebinding-simulation.example.com/', { dispatcher } as never)
    ).rejects.toThrow()
  })

  it('rejects a connection whose freshly-resolved address is private even after an earlier successful hostname validation (DNS rebinding)', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]) // registration-time
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]) // check-time rebind

    await assertUrlIsMonitorable('http://rebind.example.com/') // passes at "registration time"

    const dispatcher = createSsrfSafeDispatcher()
    await expect(fetch('http://rebind.example.com/', { dispatcher } as never)).rejects.toThrow()
  })
})
