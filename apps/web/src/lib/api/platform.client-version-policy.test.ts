// Story 43.7 AC-2 / AC-5: `fetchClientVersionPolicy` — the never-throwing, server-side helper the
// Version & Upgrade loader uses to read GET /api/v1/client-version-policy through the web proxy.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CLIENT_VERSION_POLICY_MAX_BODY_LENGTH,
  CLIENT_VERSION_POLICY_TIMEOUT_MS,
  fetchClientVersionPolicy,
  type CliVersionPolicy,
} from './platform.js'

const here = dirname(fileURLToPath(import.meta.url))

const ADMIN_REASON = "Withdrawn by this server's administrator."

function validBody(): Record<string, unknown> {
  return {
    data: {
      schemaVersion: 1,
      server: { version: '1.3.0', versionSource: 'release' },
      clients: {
        cli: {
          current: '1.3.0',
          minimumSupported: '1.1.0',
          withdrawn: [{ version: '1.2.1', reason: ADMIN_REASON }],
        },
      },
    },
  }
}

const EXPECTED_POLICY: CliVersionPolicy = {
  server: { version: '1.3.0', versionSource: 'release' },
  cli: {
    current: '1.3.0',
    minimumSupported: '1.1.0',
    withdrawn: [{ version: '1.2.1', reason: ADMIN_REASON }],
  },
}

function textResponse(text: string | null, status = 200, headers: Record<string, string> = {}) {
  return new Response(text, { status, headers })
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return textResponse(JSON.stringify(body), status, {
    'content-type': 'application/json',
    ...headers,
  })
}

function fetchReturning(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

async function resultFor(body: unknown) {
  return fetchClientVersionPolicy(fetchReturning(jsonResponse(body)))
}

function withCli(cli: Record<string, unknown>) {
  const body = validBody()
  const data = body.data as Record<string, unknown>
  const clients = data.clients as Record<string, unknown>
  clients.cli = { ...(clients.cli as Record<string, unknown>), ...cli }
  return body
}

function withServer(server: unknown) {
  const body = validBody()
  ;(body.data as Record<string, unknown>).server = server
  return body
}

const INVALID = { status: 'unavailable', reason: 'invalid_response' }

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchClientVersionPolicy — request (AC-2)', () => {
  it('requests the constant path once with credentials omitted, an accept header, a signal, no authorization and no redirect option', async () => {
    const fetchFn = fetchReturning(jsonResponse(validBody()))

    await fetchClientVersionPolicy(fetchFn)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [path, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/v1/client-version-policy')
    expect(init.credentials).toBe('omit')
    const headers = new Headers(init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('authorization')).toBe(false)
    expect(init).not.toHaveProperty('redirect')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('makes exactly one request per invocation, even on 429 (no retry)', async () => {
    const fetchFn = fetchReturning(textResponse('{}', 429))

    await fetchClientVersionPolicy(fetchFn)

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('fetchClientVersionPolicy — status mapping (AC-2)', () => {
  it('200 with a valid body → ok with the documented shape', async () => {
    await expect(resultFor(validBody())).resolves.toEqual({ status: 'ok', policy: EXPECTED_POLICY })
  })

  it.each([
    [404, 'not_supported'],
    [429, 'rate_limited'],
    [502, 'api_unavailable'],
    [503, 'api_unavailable'],
    [504, 'api_unavailable'],
    [302, 'error'],
    [401, 'error'],
    [403, 'error'],
    [500, 'error'],
    [204, 'error'],
  ])('status %i → %s', async (status, reason) => {
    const response = status === 204 ? textResponse(null, 204) : textResponse('{}', status)
    await expect(fetchClientVersionPolicy(fetchReturning(response))).resolves.toEqual({
      status: 'unavailable',
      reason,
    })
  })

  it('a rejecting fetch (network error) → api_unavailable, never throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(fetchClientVersionPolicy(fetchFn)).resolves.toEqual({
      status: 'unavailable',
      reason: 'api_unavailable',
    })
  })

  it('a synchronously throwing fetch → api_unavailable, never throws', async () => {
    const fetchFn = (() => {
      throw new TypeError('boom')
    }) as unknown as typeof fetch
    await expect(fetchClientVersionPolicy(fetchFn)).resolves.toEqual({
      status: 'unavailable',
      reason: 'api_unavailable',
    })
  })

  it('200 with a non-JSON body → invalid_response', async () => {
    await expect(
      fetchClientVersionPolicy(fetchReturning(textResponse('<html>oops</html>')))
    ).resolves.toEqual(INVALID)
  })

  it('200 whose body read rejects → invalid_response', async () => {
    const response = {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream broke')),
    } as unknown as Response
    await expect(fetchClientVersionPolicy(fetchReturning(response))).resolves.toEqual(INVALID)
  })

  it.each([
    ['null', 'null'],
    ['[]', '[]'],
    ['"string"', '"string"'],
    ['{}', '{}'],
  ])('200 with body %s → invalid_response', async (_label, text) => {
    await expect(fetchClientVersionPolicy(fetchReturning(textResponse(text)))).resolves.toEqual(
      INVALID
    )
  })

  it('a 401 never throws and never redirects: it maps to error', async () => {
    await expect(
      fetchClientVersionPolicy(fetchReturning(textResponse('{"error":"unauthorized"}', 401)))
    ).resolves.toEqual({ status: 'unavailable', reason: 'error' })
  })
})

describe('fetchClientVersionPolicy — size cap (AC-2)', () => {
  it(`accepts a body of exactly ${CLIENT_VERSION_POLICY_MAX_BODY_LENGTH} UTF-16 units and rejects one more`, async () => {
    expect(CLIENT_VERSION_POLICY_MAX_BODY_LENGTH).toBe(65_536)
    const json = JSON.stringify(validBody())
    const atCap = json.padEnd(CLIENT_VERSION_POLICY_MAX_BODY_LENGTH, ' ')
    const overCap = json.padEnd(CLIENT_VERSION_POLICY_MAX_BODY_LENGTH + 1, ' ')

    await expect(fetchClientVersionPolicy(fetchReturning(textResponse(atCap)))).resolves.toEqual({
      status: 'ok',
      policy: EXPECTED_POLICY,
    })
    await expect(fetchClientVersionPolicy(fetchReturning(textResponse(overCap)))).resolves.toEqual(
      INVALID
    )
  })
})

describe('fetchClientVersionPolicy — validation (AC-2, all-or-nothing)', () => {
  it.each<[string, unknown]>([
    ['data missing', {}],
    ['data not an object', { data: 'x' }],
    ['data an array', { data: [] }],
    ['server missing', withServer(undefined)],
    ['server not an object', withServer('1.3.0')],
    ['server.version missing', withServer({ versionSource: 'release' })],
    ['server.version empty', withServer({ version: '', versionSource: 'release' })],
    ['server.version not a string', withServer({ version: 1, versionSource: 'release' })],
    [
      'server.version 129 chars',
      withServer({ version: 'v'.repeat(129), versionSource: 'release' }),
    ],
    ['server.versionSource unknown', withServer({ version: '1.3.0', versionSource: 'nightly' })],
    ['server.versionSource missing', withServer({ version: '1.3.0' })],
    ['clients missing', { data: { server: { version: '1.3.0', versionSource: 'release' } } }],
    [
      'clients.cli missing',
      { data: { server: { version: '1.3.0', versionSource: 'release' }, clients: {} } },
    ],
    [
      'clients.cli not an object',
      { data: { server: { version: '1.3.0', versionSource: 'release' }, clients: { cli: 'x' } } },
    ],
    ['current a number', withCli({ current: 130 })],
    ['current missing', withCli({ current: undefined })],
    ['current empty', withCli({ current: '' })],
    ['current 129 chars', withCli({ current: '1'.repeat(129) })],
    ['minimumSupported a boolean', withCli({ minimumSupported: false })],
    ['minimumSupported empty', withCli({ minimumSupported: '' })],
    ['minimumSupported 129 chars', withCli({ minimumSupported: '1'.repeat(129) })],
    ['withdrawn not an array', withCli({ withdrawn: '1.2.1' })],
    ['withdrawn null', withCli({ withdrawn: null })],
    ['withdrawn entry not an object', withCli({ withdrawn: ['1.2.1'] })],
    ['withdrawn entry null', withCli({ withdrawn: [null] })],
    ['withdrawn entry lacks version', withCli({ withdrawn: [{ reason: 'x' }] })],
    ['withdrawn entry lacks reason', withCli({ withdrawn: [{ version: '1.2.1' }] })],
    ['withdrawn version empty', withCli({ withdrawn: [{ version: '', reason: 'x' }] })],
    [
      'withdrawn version 129 chars',
      withCli({ withdrawn: [{ version: '1'.repeat(129), reason: 'x' }] }),
    ],
    ['withdrawn reason not a string', withCli({ withdrawn: [{ version: '1.2.1', reason: 5 }] })],
    [
      'withdrawn reason 201 code points',
      withCli({ withdrawn: [{ version: '1.2.1', reason: 'r'.repeat(201) }] }),
    ],
    [
      'withdrawn reason 201 astral code points',
      withCli({ withdrawn: [{ version: '1.2.1', reason: '😀'.repeat(201) }] }),
    ],
    [
      'withdrawn with 101 entries',
      withCli({
        withdrawn: Array.from({ length: 101 }, (_, i) => ({ version: `1.0.${i}`, reason: 'x' })),
      }),
    ],
  ])('%s → invalid_response', async (_label, body) => {
    await expect(resultFor(body)).resolves.toEqual(INVALID)
  })

  it('accepts null current and minimumSupported and an empty withdrawn list (a dev server)', async () => {
    const body = withCli({ current: null, minimumSupported: null, withdrawn: [] })
    ;(body.data as Record<string, unknown>).server = {
      version: 'dev',
      versionSource: 'development',
    }

    await expect(resultFor(body)).resolves.toEqual({
      status: 'ok',
      policy: {
        server: { version: 'dev', versionSource: 'development' },
        cli: { current: null, minimumSupported: null, withdrawn: [] },
      },
    })
  })

  it('accepts the boundaries: 128-char strings, 100 entries, a 200-astral-code-point reason and an empty reason', async () => {
    const long = `1.0.0-${'a'.repeat(122)}`
    expect(long).toHaveLength(128)
    const withdrawn = Array.from({ length: 100 }, (_, i) => ({
      version: i === 0 ? long : `1.0.${i}`,
      reason: i === 0 ? '😀'.repeat(200) : i === 1 ? '' : 'x',
    }))
    const body = withCli({ current: long, minimumSupported: long, withdrawn })
    ;(body.data as Record<string, unknown>).server = { version: long, versionSource: 'release' }

    const result = await resultFor(body)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.policy.cli.withdrawn).toHaveLength(100)
      expect(result.policy.cli.withdrawn[0]?.reason).toBe('😀'.repeat(200))
      expect(result.policy.cli.withdrawn[1]?.reason).toBe('')
      expect(result.policy.server.version).toBe(long)
    }
  })

  it('ignores unknown keys and schemaVersion 2 (forward compatibility), returning a fresh object', async () => {
    const body = validBody()
    const data = body.data as Record<string, unknown>
    data.schemaVersion = 2
    data.extra = 'x'
    const clients = data.clients as Record<string, unknown>
    clients.extension = { current: '9.9.9' }
    const cli = clients.cli as Record<string, unknown>
    cli.note = 'ignored'
    cli.withdrawn = [{ version: '1.2.1', reason: ADMIN_REASON, url: 'https://evil.example/' }]
    ;(data.server as Record<string, unknown>).build = 'abc'

    const result = await resultFor(body)

    // toStrictEqual: no extra keys anywhere in the result.
    expect(result).toStrictEqual({ status: 'ok', policy: EXPECTED_POLICY })
  })

  it('preserves the server order of withdrawn entries (no re-sorting) and duplicates as-is', async () => {
    const withdrawn = [
      { version: '1.2.1', reason: 'a' },
      { version: '1.0.0-rc.2', reason: 'b' },
      { version: '0.9.9', reason: 'c' },
      { version: '0.9.9', reason: 'c' },
    ]
    const result = await resultFor(withCli({ withdrawn }))

    expect(result).toEqual({
      status: 'ok',
      policy: { ...EXPECTED_POLICY, cli: { ...EXPECTED_POLICY.cli, withdrawn } },
    })
  })

  it('AC-5: response headers (set-cookie, x-powered-by) and extra body keys never reach the result', async () => {
    const body = { ...validBody(), meta: { secret: 'nope' } }
    const response = jsonResponse(body, 200, {
      'set-cookie': 'session=SECRET-COOKIE-VALUE; HttpOnly',
      'x-powered-by': 'Fastify',
    })

    const result = await fetchClientVersionPolicy(fetchReturning(response))

    expect(result).toStrictEqual({ status: 'ok', policy: EXPECTED_POLICY })
    expect(JSON.stringify(result)).not.toContain('SECRET-COOKIE-VALUE')
    expect(JSON.stringify(result)).not.toContain('Fastify')
  })
})

describe('fetchClientVersionPolicy — timeout (AC-2)', () => {
  it(`times out at ${CLIENT_VERSION_POLICY_TIMEOUT_MS} ms for a fetch that never resolves and ignores the signal, aborting the signal`, async () => {
    vi.useFakeTimers()
    expect(CLIENT_VERSION_POLICY_TIMEOUT_MS).toBe(3000)
    let signal: AbortSignal | undefined
    const fetchFn = vi.fn((_path: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch

    const pending = fetchClientVersionPolicy(fetchFn)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out when headers resolve but the body read never does', async () => {
    vi.useFakeTimers()
    const response = {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => new Promise<string>(() => {}),
    } as unknown as Response

    const pending = fetchClientVersionPolicy(fetchReturning(response))
    await vi.advanceTimersByTimeAsync(3000)

    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a response resolving at 2999 ms is ok; the timer is cleared', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolveResponse) => {
          setTimeout(() => resolveResponse(jsonResponse(validBody())), 2999)
        })
    ) as unknown as typeof fetch

    const pending = fetchClientVersionPolicy(fetchFn)
    await vi.advanceTimersByTimeAsync(2999)

    await expect(pending).resolves.toEqual({ status: 'ok', policy: EXPECTED_POLICY })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a response not resolved at 3000 ms times out', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolveResponse) => {
          setTimeout(() => resolveResponse(jsonResponse(validBody())), 3001)
        })
    ) as unknown as typeof fetch

    const pending = fetchClientVersionPolicy(fetchFn)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer after a failure', async () => {
    vi.useFakeTimers()
    await fetchClientVersionPolicy(fetchReturning(textResponse('{}', 500)))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the signal after a successful read (no body stream left open)', async () => {
    let signal: AbortSignal | undefined
    const fetchFn = vi.fn(async (_path: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return jsonResponse(validBody())
    }) as unknown as typeof fetch

    await fetchClientVersionPolicy(fetchFn)

    expect(signal?.aborted).toBe(true)
  })
})

describe('fetchClientVersionPolicy — structure (AC-2 G6)', () => {
  it('the helper does not use apiFetch (no 401 refresh/login-redirect flow, no ApiClientError)', () => {
    const platformSource = readFileSync(resolve(here, 'platform.ts'), 'utf-8')
    // Every Story 43.7 line in platform.ts sits between these two markers.
    const start = platformSource.indexOf('// ---- Story 43.7: client version policy')
    const end = platformSource.indexOf('// ---- end Story 43.7')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const helperRegion = platformSource.slice(start, end)
    expect(helperRegion).toContain('export async function fetchClientVersionPolicy')
    expect(helperRegion).not.toMatch(/apiFetch|ApiClientError/)

    const validatorSource = readFileSync(
      resolve(here, 'client-version-policy-validate.ts'),
      'utf-8'
    )
    expect(validatorSource).not.toMatch(/apiFetch|client\.js/)
  })
})
