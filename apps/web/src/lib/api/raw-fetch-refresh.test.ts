import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from './client.js'
import { exportProject, importProject } from './project-export.js'
import { previewCredentialImport } from './credentials.js'
import { runAccessReportCsv } from './audit.js'
import { jsonResponse } from '$lib/test/json-response.js'

// Story 62-6 — the browser raw-fetch helpers (binary export, multipart imports, CSV) must follow
// the 61-3 session-refresh contract: one refresh on a refreshable 401, one retry, tri-state outcome.

const gotoMock = vi.hoisted(() => vi.fn())
vi.mock('$app/navigation', () => ({ goto: gotoMock }))

const REFRESH = '/api/v1/auth/refresh'
const BYTES = [0x00, 0xff, 0xfe]

function missing401(): Response {
  return jsonResponse(
    { code: 'access_token_missing', message: 'Access token is missing' },
    { status: 401 }
  )
}

type Script = Array<() => Response | Promise<Response>>

function scripted(script: Script) {
  let index = 0
  return vi.fn(async (..._args: unknown[]) => {
    const step = script[index++]
    if (!step) throw new Error('unexpected extra fetch call')
    return step()
  })
}

function makeFile(): File {
  return new File([new Uint8Array(BYTES)], 'p.pvexport', { type: 'application/octet-stream' })
}

type HelperCase = {
  name: string
  url: string
  call: (fetchFn: typeof fetch) => Promise<unknown>
  ok: () => Response
  expectResult: (result: unknown) => Promise<void>
}

const CASES: HelperCase[] = [
  {
    name: 'exportProject',
    url: '/api/v1/projects/p1/export',
    call: (f) => exportProject(f, 'p1'),
    ok: () =>
      new Response(new Uint8Array(BYTES), {
        status: 200,
        headers: {
          'x-export-key': 'k1',
          'content-disposition': 'attachment; filename="p.pvexport"',
        },
      }),
    expectResult: async (result) => {
      const { blob, filename, exportKey } = result as Awaited<ReturnType<typeof exportProject>>
      expect(filename).toBe('p.pvexport')
      expect(exportKey).toBe('k1')
      expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(BYTES)
    },
  },
  {
    name: 'importProject',
    url: '/api/v1/projects/import',
    call: (f) => importProject(f, makeFile(), 'the-key', 'Renamed'),
    ok: () => jsonResponse({ data: { projectId: 'p2', name: 'Renamed', importedCounts: {} } }),
    expectResult: async (result) => {
      expect(result).toEqual({ projectId: 'p2', name: 'Renamed', importedCounts: {} })
    },
  },
  {
    name: 'previewCredentialImport',
    url: '/api/v1/projects/p1/credentials/import',
    call: (f) => previewCredentialImport(f, 'p1', makeFile()),
    ok: () => jsonResponse({ data: { rows: [] } }),
    expectResult: async (result) => {
      expect(result).toEqual({ rows: [] })
    },
  },
  {
    name: 'runAccessReportCsv',
    url: '/api/v1/org/audit/access-report',
    call: (f) => runAccessReportCsv(f, {}),
    ok: () => new Response('a,b\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } }),
    expectResult: async (result) => {
      expect(result).toBe('a,b\n1,2\n')
    },
  },
]

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

describe.each(CASES)('$name session refresh (Story 62-6)', (helper) => {
  beforeEach(() => {
    gotoMock.mockReset()
    gotoMock.mockResolvedValue(undefined)
  })

  it('refreshes once and retries once with the same target when the access cookie is stale', async () => {
    const fetchFn = scripted([missing401, () => jsonResponse({ data: {} }), helper.ok])

    await helper.expectResult(await helper.call(fetchFn as unknown as typeof fetch))

    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([helper.url, REFRESH, helper.url])
    const refreshInit = (fetchFn.mock.calls[1] as unknown[])[1] as RequestInit
    expect(refreshInit.signal).toBeUndefined()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('does not refresh when the first call succeeds', async () => {
    const fetchFn = scripted([helper.ok])

    await helper.expectResult(await helper.call(fetchFn as unknown as typeof fetch))

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403])(
    'redirects once and throws session_expired when the refresh answers %s',
    async (status) => {
      const fetchFn = scripted([missing401, () => jsonResponse({ code: 'x' }, { status })])

      const error = await caught(helper.call(fetchFn as unknown as typeof fetch))

      expect(error).toBeInstanceOf(ApiClientError)
      expect(error).toMatchObject({ status: 401, code: 'session_expired' })
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(gotoMock).toHaveBeenCalledTimes(1)
      expect(gotoMock).toHaveBeenCalledWith('/login?reason=session-expired')
    }
  )

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 400', () => jsonResponse({ code: 'bad' }, { status: 400 })],
    ['a 429', () => jsonResponse({ code: 'rate_limited' }, { status: 429 })],
    ['a 503', () => jsonResponse({ status: 'sealed' }, { status: 503 })],
    ['a non-JSON 200', () => new Response('<html>', { status: 200 })],
  ] as Array<[string, () => Response | Promise<Response>]>)(
    'surfaces the original 401 without redirecting when the refresh is unavailable (%s)',
    async (_label, refresh) => {
      const fetchFn = scripted([missing401, refresh])

      const error = await caught(helper.call(fetchFn as unknown as typeof fetch))

      expect(error).toMatchObject({
        name: 'ApiClientError',
        status: 401,
        code: 'access_token_missing',
        message: 'Access token is missing',
      })
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(gotoMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      'a 403 mfa_required',
      () => jsonResponse({ code: 'mfa_required', message: 'm' }, { status: 403 }),
      403,
    ],
    ['a 404', () => jsonResponse({ code: 'not_found', message: 'n' }, { status: 404 }), 404],
    ['a 413', () => jsonResponse({ code: 'too_large', message: 'l' }, { status: 413 }), 413],
    [
      'a non-refreshable 401',
      () => jsonResponse({ code: 'invalid_credentials', message: 'i' }, { status: 401 }),
      401,
    ],
    ['a non-JSON 401', () => new Response('nope', { status: 401 }), 401],
  ] as Array<[string, () => Response, number]>)(
    'throws %s as an ApiClientError with no refresh',
    async (_label, first, status) => {
      const fetchFn = scripted([first])

      const error = await caught(helper.call(fetchFn as unknown as typeof fetch))

      expect(error).toBeInstanceOf(ApiClientError)
      expect((error as ApiClientError).status).toBe(status)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(gotoMock).not.toHaveBeenCalled()
    }
  )

  it('never retries twice: a 401 on the retry is thrown after exactly three requests', async () => {
    const fetchFn = scripted([missing401, () => jsonResponse({ data: {} }), missing401])

    const error = await caught(helper.call(fetchFn as unknown as typeof fetch))

    expect(error).toMatchObject({ status: 401, code: 'access_token_missing' })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(gotoMock).not.toHaveBeenCalled()
  })
})

describe('request rebuilding (Story 62-6)', () => {
  beforeEach(() => {
    gotoMock.mockReset()
    gotoMock.mockResolvedValue(undefined)
  })

  it('importProject rebuilds the FormData for the retry and never sets Content-Type', async () => {
    const fetchFn = scripted([
      missing401,
      () => jsonResponse({ data: {} }),
      () => jsonResponse({ data: { projectId: 'p', name: 'n', importedCounts: {} } }),
    ])

    await importProject(fetchFn as unknown as typeof fetch, makeFile(), 'the-key', 'Renamed')

    const first = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit
    const second = (fetchFn.mock.calls[2] as unknown[])[1] as RequestInit
    expect(second.body).toBeInstanceOf(FormData)
    expect(second.body).not.toBe(first.body)
    for (const init of [first, second]) {
      const form = init.body as FormData
      expect(form.get('exportKey')).toBe('the-key')
      expect(form.get('projectName')).toBe('Renamed')
      expect((form.get('file') as File).name).toBe('p.pvexport')
      expect((form.get('file') as File).size).toBe(BYTES.length)
      expect(init.credentials).toBe('include')
      expect(new Headers(init.headers).has('content-type')).toBe(false)
    }
  })

  it('previewCredentialImport rebuilds the FormData for the retry', async () => {
    const fetchFn = scripted([
      missing401,
      () => jsonResponse({ data: {} }),
      () => jsonResponse({ data: { rows: [] } }),
    ])

    await previewCredentialImport(fetchFn as unknown as typeof fetch, 'p1', makeFile())

    const first = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit
    const second = (fetchFn.mock.calls[2] as unknown[])[1] as RequestInit
    expect(second.body).not.toBe(first.body)
    expect(((second.body as FormData).get('file') as File).size).toBe(BYTES.length)
  })

  it('runAccessReportCsv sends the same JSON body with Content-Type on both attempts', async () => {
    const fetchFn = scripted([
      missing401,
      () => jsonResponse({ data: {} }),
      () => new Response('x'),
    ])

    await runAccessReportCsv(fetchFn as unknown as typeof fetch, {})

    const first = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit
    const second = (fetchFn.mock.calls[2] as unknown[])[1] as RequestInit
    expect(second.body).toBe(first.body)
    expect(second.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('exportProject takes the key and filename from the retried response only', async () => {
    const stale = () =>
      jsonResponse(
        { code: 'access_token_missing', message: 'x' },
        { status: 401, headers: { 'x-export-key': 'stale-key' } }
      )
    const fetchFn = scripted([
      stale,
      () => jsonResponse({ data: {} }),
      () => new Response('b', { headers: { 'x-export-key': 'fresh-key' } }),
    ])

    const result = await exportProject(fetchFn as unknown as typeof fetch, 'p1')

    expect(result.exportKey).toBe('fresh-key')
  })
})

describe('concurrency (Story 62-6)', () => {
  beforeEach(() => {
    gotoMock.mockReset()
  })

  it('two helpers hitting 401 at once share one refresh and each retry once', async () => {
    const seen = new Map<string, number>()
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const count = (seen.get(url) ?? 0) + 1
      seen.set(url, count)
      if (url === REFRESH) {
        await Promise.resolve()
        return jsonResponse({ data: {} })
      }
      if (count === 1) return missing401()
      return url.endsWith('/export')
        ? new Response('b', { headers: { 'x-export-key': 'k' } })
        : new Response('a,b')
    }) as unknown as typeof fetch

    await Promise.all([exportProject(fetchFn, 'p1'), runAccessReportCsv(fetchFn, {})])

    expect(seen.get(REFRESH)).toBe(1)
    expect(seen.get('/api/v1/projects/p1/export')).toBe(2)
    expect(seen.get('/api/v1/org/audit/access-report')).toBe(2)
  })

  it('two helpers failing on a dead session call goto exactly once', async () => {
    let settle: () => void = () => {}
    gotoMock.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)))
    const fetchFn = vi.fn(async (input: string | URL | Request) =>
      String(input) === REFRESH ? jsonResponse({ code: 'x' }, { status: 401 }) : missing401()
    ) as unknown as typeof fetch

    const results = await Promise.all([
      caught(exportProject(fetchFn, 'p1')),
      caught(runAccessReportCsv(fetchFn, {})),
    ])
    settle()

    expect(results.every((r) => r instanceof ApiClientError)).toBe(true)
    expect(gotoMock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchFn).mock.calls.filter((c) => c[0] === REFRESH)).toHaveLength(1)
  })
})
