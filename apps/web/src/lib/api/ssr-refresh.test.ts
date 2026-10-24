import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { ApiClientError, apiFetchBody } from './client.js'
import { listAuditEvents } from './audit.js'
import {
  dismissInboxEntry,
  getNotificationInbox,
  markAllInboxRead,
  markInboxEntryRead,
} from './inbox.js'
import { jsonResponse } from '$lib/test/json-response.js'

// Story 62-6 — the SSR raw-fetch helpers (audit list, notification inbox) refresh through apiFetch /
// apiFetchBody. `browser` is false: every call does its own refresh and a dead session redirects.

vi.mock('$app/environment', () => ({ browser: false }))
const gotoMock = vi.hoisted(() => vi.fn())
vi.mock('$app/navigation', () => ({ goto: gotoMock }))

const REFRESH = '/api/v1/auth/refresh'

const AUDIT_BODY = { data: [{ id: 'e1' }], page: 1, limit: 20, total: 41, hasNext: true }
const INBOX_BODY = { data: { items: [], total: 0, page: 1, limit: 20, hasNext: false } }

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

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

type SsrCase = {
  name: string
  call: (fetchFn: typeof fetch) => Promise<unknown>
  ok: () => Response
  result: unknown
  // dismissInboxEntry swallows non-redirect failures into `false` by contract.
  failureResult?: unknown
}

const CASES: SsrCase[] = [
  {
    name: 'listAuditEvents',
    call: (f) => listAuditEvents(f, {}),
    ok: () => jsonResponse(AUDIT_BODY),
    result: AUDIT_BODY,
  },
  {
    name: 'getNotificationInbox',
    call: (f) => getNotificationInbox(f),
    ok: () => jsonResponse(INBOX_BODY),
    result: INBOX_BODY,
  },
  {
    name: 'markInboxEntryRead',
    call: (f) => markInboxEntryRead(f, 'n1'),
    ok: () => new Response(null, { status: 204 }),
    result: undefined,
  },
  {
    name: 'markAllInboxRead',
    call: (f) => markAllInboxRead(f),
    ok: () => new Response(null, { status: 204 }),
    result: undefined,
  },
  {
    name: 'dismissInboxEntry',
    call: (f) => dismissInboxEntry(f, 'n1'),
    ok: () => new Response(null, { status: 204 }),
    result: true,
    failureResult: false,
  },
]

describe.each(CASES)('$name during SSR (Story 62-6)', (helper) => {
  beforeEach(() => gotoMock.mockReset())

  it('refreshes and retries once on a stale access cookie, resolving the same value', async () => {
    const fetchFn = scripted([missing401, () => jsonResponse({ data: {} }), helper.ok])

    const result = await helper.call(fetchFn as unknown as typeof fetch)

    expect(result).toEqual(helper.result)
    const urls = fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))
    expect(urls[1]).toBe(REFRESH)
    expect(urls).toHaveLength(3)
    expect(urls[2]).toBe(urls[0])
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it.each([401, 403])('redirects to login (303) when the refresh answers %s', async (status) => {
    const fetchFn = scripted([missing401, () => jsonResponse({ code: 'x' }, { status })])

    const error = await caught(helper.call(fetchFn as unknown as typeof fetch))

    expect(isRedirect(error)).toBe(true)
    expect(error).toMatchObject({ status: 303, location: '/login?reason=session-expired' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not redirect when the refresh is unavailable', async () => {
    const fetchFn = scripted([missing401, () => jsonResponse({ code: 'x' }, { status: 503 })])

    const outcome = await helper.call(fetchFn as unknown as typeof fetch).catch((e) => e)

    if (helper.failureResult !== undefined) {
      expect(outcome).toBe(helper.failureResult)
    } else {
      expect(outcome).toMatchObject({ name: 'ApiClientError', status: 401 })
    }
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not refresh on a 403', async () => {
    const fetchFn = scripted([() => jsonResponse({ code: 'mfa_required' }, { status: 403 })])

    const outcome = await helper.call(fetchFn as unknown as typeof fetch).catch((e) => e)

    if (helper.failureResult !== undefined) expect(outcome).toBe(helper.failureResult)
    else expect(outcome).toMatchObject({ name: 'ApiClientError', status: 403 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('never loops: a 401 on the retry is surfaced after three requests', async () => {
    const fetchFn = scripted([missing401, () => jsonResponse({ data: {} }), missing401])

    const outcome = await helper.call(fetchFn as unknown as typeof fetch).catch((e) => e)

    if (helper.failureResult !== undefined) expect(outcome).toBe(helper.failureResult)
    else expect(outcome).toMatchObject({ name: 'ApiClientError', status: 401 })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
})

describe('inbox failures keep their status (Story 62-6, T2)', () => {
  it('getNotificationInbox throws an ApiClientError with the 403 status', async () => {
    const fetchFn = scripted([
      () => jsonResponse({ code: 'forbidden', message: 'no' }, { status: 403 }),
    ])

    const error = await caught(getNotificationInbox(fetchFn as unknown as typeof fetch))

    expect(error).toBeInstanceOf(ApiClientError)
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('dismissInboxEntry resolves false on a 404', async () => {
    const fetchFn = scripted([() => jsonResponse({ code: 'not_found' }, { status: 404 })])

    expect(await dismissInboxEntry(fetchFn as unknown as typeof fetch, 'n1')).toBe(false)
  })
})

describe('apiFetchBody (Story 62-6)', () => {
  it('returns the whole body, keeping siblings of data', async () => {
    const fetchFn = scripted([() => jsonResponse(AUDIT_BODY)])

    expect(await apiFetchBody(fetchFn as unknown as typeof fetch, '/x')).toEqual(AUDIT_BODY)
  })

  it('throws ApiClientError with the server message on failure', async () => {
    const fetchFn = scripted([() => jsonResponse({ message: 'slow down' }, { status: 429 })])

    const error = await caught(apiFetchBody(fetchFn as unknown as typeof fetch, '/x'))

    expect(error).toMatchObject({ name: 'ApiClientError', status: 429, message: 'slow down' })
  })
})
