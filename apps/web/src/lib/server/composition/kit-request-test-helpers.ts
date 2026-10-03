// Story 68.6 — a fake SvelteKit request that behaves like Kit 2.70.3's `respond.js` where the
// hooks can observe it: `setHeaders` lowercases names, throws on `set-cookie` and on a second set
// of the same name (except `server-timing`), and `resolve` applies the recorded headers to the
// returned Response exactly as `respond.js` does inside `resolve(...).then(...)`. A response the
// handle returns itself (a redirect) therefore carries no `setHeaders` headers, as in Kit.

export interface FakeChunkOptions {
  transformPageChunk?: (input: {
    html: string
    done: boolean
  }) => string | undefined | Promise<string | undefined>
}

export interface FakeKitRequest {
  event: {
    url: URL
    request: Request
    route: { id: string | null }
    locals: { user?: unknown }
    setHeaders: (headers: Record<string, string>) => void
  }
  resolve: (event: FakeKitRequest['event'], opts?: FakeChunkOptions) => Promise<Response>
  /** Every `setHeaders` call's argument, in order. */
  setHeadersCalls: Record<string, string>[]
  /** Pathname of each event `resolve` received (empty when the handle short-circuited). */
  resolvedPathnames: string[]
  /** The `transformPageChunk` output for the probe chunk, or null when `resolve` never ran. */
  chunk: string | null
}

export const PROBE_CHUNK = '<html lang="%paraglide.lang%">'

export function fakeKitRequest(
  pathname: string,
  {
    cookie = null,
    routeId = null,
    method = 'GET',
    resolveDelayMs = 0,
  }: {
    cookie?: string | null
    routeId?: string | null
    method?: string
    resolveDelayMs?: number
  } = {}
): FakeKitRequest {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  const applied = new Map<string, string>()
  const record: FakeKitRequest = {
    setHeadersCalls: [],
    resolvedPathnames: [],
    chunk: null,
    event: {
      url: new URL(`http://localhost${pathname}`),
      request: new Request(`http://localhost${pathname}`, { headers, method }),
      route: { id: routeId },
      locals: {},
      setHeaders: (next) => {
        record.setHeadersCalls.push({ ...next })
        for (const [key, value] of Object.entries(next)) {
          const lower = key.toLowerCase()
          if (lower === 'set-cookie') throw new Error('Use `event.cookies.set` for cookies')
          if (applied.has(lower)) throw new Error(`"${key}" header is already set`)
          applied.set(lower, value)
        }
      },
    },
    resolve: async (ev, opts) => {
      record.resolvedPathnames.push(ev.url.pathname)
      if (resolveDelayMs > 0) await new Promise((r) => setTimeout(r, resolveDelayMs))
      record.chunk =
        (await opts?.transformPageChunk?.({ html: PROBE_CHUNK, done: true })) ?? PROBE_CHUNK
      const response = new Response('ok', { status: 200 })
      for (const [key, value] of applied) response.headers.set(key, value)
      return response
    },
  }
  return record
}

/** Every observable part of a response the hooks produced, as plain JSON. */
export function describeResponse(response: Response) {
  const headers = Object.fromEntries(
    [...response.headers.entries()].filter(([key]) => key !== 'set-cookie')
  )
  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookie: response.headers.getSetCookie(),
    headers,
  }
}
