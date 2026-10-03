// Story 68.6 AC-4 — `composeHandles()` against Kit's real `sequence()` as a differential oracle.
// `sequence()` needs Kit's request store, so the oracle side runs inside `with_request_store` from
// `@sveltejs/kit/internal/server` (test-only). If that internal export disappears on a Kit upgrade
// this suite fails loudly: re-point it, never delete it.
import type { Handle, RequestEvent, ResolveOptions } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
import { describe, expect, it } from 'vitest'
import { composeHandles } from './compose-handles.js'
import { PV_HEADER_POLICY } from '$lib/security/header-policy.js'
import { fakeKitRequest } from './kit-request-test-helpers.js'

// Kit ships no type declarations for this internal entry point; it is test-only here.
interface KitInternalServer {
  getRequestEvent: () => RequestEvent
  with_request_store: <T>(store: unknown, fn: () => T) => T
}
const KIT_INTERNAL_SERVER = '@sveltejs/kit/internal/server'
const { getRequestEvent, with_request_store } = (await import(
  /* @vite-ignore */ KIT_INTERNAL_SERVER
)) as KitInternalServer

type Log = string[]
type Resolve = (event: RequestEvent, opts?: ResolveOptions) => Promise<Response>

const noopSpan = { setAttribute() {}, setAttributes() {}, end() {} }
const fakeState = {
  tracing: { record_span: ({ fn }: { fn: (span: unknown) => unknown }) => fn(noopSpan) },
}

function makeEvent(pathname = '/x'): RequestEvent {
  return {
    url: new URL(`http://localhost${pathname}`),
    request: new Request(`http://localhost${pathname}`),
    locals: {},
    route: { id: null },
    setHeaders: () => undefined,
    tracing: { enabled: false, root: noopSpan, current: noopSpan },
  } as unknown as RequestEvent
}

/** The real `resolve`: records the options it received and runs every chunk through them. */
function recordingResolve(log: Log, chunks: Array<{ html: string; done: boolean }>): Resolve {
  return async (event, opts) => {
    log.push(`resolve:${event.url.pathname}`)
    const out: string[] = []
    for (const chunk of chunks) out.push((await opts?.transformPageChunk?.(chunk)) ?? chunk.html)
    log.push(`chunks:${JSON.stringify(out)}`)
    log.push(`preload:${String(opts?.preload?.({ type: 'js', path: '/a.js' }))}`)
    log.push(`filter:${String(opts?.filterSerializedResponseHeaders?.('x-test', 'v'))}`)
    return new Response(out.join(''), { status: 200 })
  }
}

async function runBoth(
  build: (log: Log) => Handle[],
  chunks: Array<{ html: string; done: boolean }> = [{ html: '<p>', done: true }],
  event: () => RequestEvent = () => makeEvent()
) {
  const run = async (compose: (handles: Handle[]) => Handle, store: boolean) => {
    const log: Log = []
    const handle = compose(build(log))
    const resolve = recordingResolve(log, chunks)
    const ev = event()
    const call = () => handle({ event: ev, resolve })
    let outcome: string
    try {
      const response = await (store
        ? with_request_store({ event: ev, state: fakeState } as never, call)
        : call())
      outcome = `${response.status}:${response.headers.get('location') ?? ''}:${await response.text()}`
    } catch (error) {
      outcome = `threw:${(error as Error).message}`
    }
    return { log, outcome }
  }
  const ours = await run((handles) => composeHandles(handles), false)
  const kits = await run((handles) => sequence(...handles), true)
  return { ours, kits }
}

function tracer(i: number, log: Log): Handle {
  return async ({ event, resolve }) => {
    log.push(`pre:${i}`)
    const response = await resolve(event)
    log.push(`post:${i}`)
    return response
  }
}

describe('composeHandles — parity with sequence() (AC-4)', () => {
  it('1+2: runs pre-processing forward and post-processing in reverse', async () => {
    const { ours, kits } = await runBoth((log) => [0, 1, 2].map((i) => tracer(i, log)))
    expect(ours).toEqual(kits)
    expect(ours.log.filter((l) => /^(pre|post):/.test(l))).toEqual([
      'pre:0',
      'pre:1',
      'pre:2',
      'post:2',
      'post:1',
      'post:0',
    ])
  })

  it('3: applies transformPageChunk innermost-first, `?? ""` per step, done passed through', async () => {
    const tag =
      (i: number, log: Log): Handle =>
      ({ event, resolve }) =>
        resolve(event, {
          transformPageChunk: ({ html, done }) => {
            log.push(`t${i}:${String(done)}`)
            return i === 2 && html === 'drop' ? undefined : `${html}[${i}]`
          },
        })
    const chunks = [
      { html: 'a', done: false },
      { html: 'drop', done: true },
    ]
    const { ours, kits } = await runBoth((log) => [0, 1, 2].map((i) => tag(i, log)), chunks)
    expect(ours).toEqual(kits)
    expect(ours.log).toContain('chunks:["a[2][1][0]","[1][0]"]')
  })

  it('3b: a transform-less handle in the middle keeps the parents transform chain', async () => {
    const { ours, kits } = await runBoth((log) => [
      ({ event, resolve }) => resolve(event, { transformPageChunk: ({ html }) => `${html}[0]` }),
      tracer(1, log),
      ({ event, resolve }) => resolve(event, { transformPageChunk: ({ html }) => `${html}[2]` }),
    ])
    expect(ours).toEqual(kits)
  })

  it('4: preload and filterSerializedResponseHeaders are first-wins; undefined lets the next through', async () => {
    const { ours, kits } = await runBoth(() => [
      ({ event, resolve }) => resolve(event, { preload: () => true }),
      ({ event, resolve }) =>
        resolve(event, {
          preload: () => false,
          filterSerializedResponseHeaders: (name) => name === 'x-test',
        }),
      ({ event, resolve }) =>
        resolve(event, { preload: () => false, filterSerializedResponseHeaders: () => false }),
    ])
    expect(ours).toEqual(kits)
    expect(ours.log).toContain('preload:true')
    expect(ours.log).toContain('filter:true')
  })

  it('5: a handle calling resolve(otherEvent) passes otherEvent to the next handle', async () => {
    const { ours, kits } = await runBoth((log) => [
      ({ resolve }) => resolve(makeEvent('/other')),
      ({ event, resolve }) => {
        log.push(`seen:${event.url.pathname}`)
        return resolve(event)
      },
    ])
    expect(ours).toEqual(kits)
    expect(ours.log).toContain('seen:/other')
    expect(ours.log).toContain('resolve:/other')
  })

  it('6: a short-circuiting handle skips the rest and the real resolve; outer post-processing runs', async () => {
    const { ours, kits } = await runBoth((log) => [
      tracer(0, log),
      () => new Response(null, { status: 303, headers: { location: '/login' } }),
      tracer(2, log),
    ])
    expect(ours).toEqual(kits)
    expect(ours.outcome).toBe('303:/login:')
    expect(ours.log).toEqual(['pre:0', 'post:0'])
  })

  it('7: resolve called twice runs the rest twice and the last response is used', async () => {
    const { ours, kits } = await runBoth((log) => [
      async ({ event, resolve }) => {
        await resolve(event)
        return resolve(event)
      },
      tracer(1, log),
    ])
    expect(ours).toEqual(kits)
    expect(ours.log.filter((l) => l.startsWith('pre:1'))).toHaveLength(2)
  })

  it('8: zero handles resolve the event with no options object', async () => {
    const calls: unknown[][] = []
    const event = makeEvent()
    await composeHandles([])({
      event,
      resolve: async (...args: unknown[]) => {
        calls.push(args)
        return new Response('z')
      },
    } as never)
    expect(calls).toEqual([[event]])
  })

  it('9: a throw rejects with the same error object; outer post-processing does not run', async () => {
    const boom = new Error('boom')
    const log: Log = []
    const handle = composeHandles([
      tracer(0, log),
      () => {
        throw boom
      },
    ])
    await expect(handle({ event: makeEvent(), resolve: recordingResolve(log, []) })).rejects.toBe(
      boom
    )
    expect(log).toEqual(['pre:0'])
    const { ours, kits } = await runBoth((l) => [
      tracer(0, l),
      () => {
        throw boom
      },
    ])
    expect(ours).toEqual(kits)
  })

  it('9b: a rejection inside a transform propagates', async () => {
    const { ours, kits } = await runBoth(() => [
      ({ event, resolve }) =>
        resolve(event, {
          transformPageChunk: async () => {
            throw new Error('transform failed')
          },
        }),
    ])
    expect(ours).toEqual(kits)
    expect(ours.outcome).toBe('threw:transform failed')
  })
})

describe('composeHandles — no request store (AC-4)', () => {
  it('works with a hand-built fake event outside any Kit request store', async () => {
    const log: Log = []
    const response = await composeHandles([tracer(0, log)])({
      event: makeEvent('/plain'),
      resolve: recordingResolve(log, []),
    })
    expect(response.status).toBe(200)
    expect(log[0]).toBe('pre:0')
  })

  it('imports nothing from @sveltejs/kit/internal and uses no AsyncLocalStorage', () => {
    const source = import.meta.glob('./compose-handles.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    })['./compose-handles.ts'] as string
    expect(source).not.toMatch(/from '@sveltejs\/kit\/internal/)
    expect(source).not.toMatch(/node:async_hooks|new AsyncLocalStorage|\.run\(/)
  })

  // Documented difference (b): sequence() re-stores the per-handle event; composeHandles does not,
  // so getRequestEvent() inside a later handle still returns the event Kit stored for the request.
  it('documented difference: getRequestEvent() returns the request-level event, not resolve(otherEvent)', async () => {
    const outer = makeEvent('/outer')
    const seen: string[] = []
    const handles: Handle[] = [
      ({ resolve }) => resolve(makeEvent('/inner')),
      ({ event, resolve }) => {
        seen.push(getRequestEvent().url.pathname)
        return resolve(event)
      },
    ]
    const resolve = recordingResolve([], [])
    await with_request_store({ event: outer, state: fakeState } as never, () =>
      composeHandles(handles)({ event: outer, resolve })
    )
    await with_request_store({ event: outer, state: fakeState } as never, () =>
      sequence(...handles)({ event: outer, resolve })
    )
    expect(seen).toEqual(['/outer', '/inner'])
  })
})

describe('composeHandles — header policy option (AC-4, AC-5)', () => {
  it('sets the resolved policy headers exactly once, before the first handle runs', async () => {
    const req = fakeKitRequest('/handoff')
    const order: string[] = []
    const handle = composeHandles(
      [
        ({ event, resolve }) => {
          order.push(`handle sees ${req.setHeadersCalls.length} setHeaders call(s)`)
          return resolve(event)
        },
      ],
      { headerPolicy: PV_HEADER_POLICY }
    )
    await handle({ event: req.event, resolve: req.resolve } as never)
    expect(order).toEqual(['handle sees 1 setHeaders call(s)'])
    expect(req.setHeadersCalls).toEqual([
      {
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin',
      },
    ])
  })

  it('sets the headers even when there are zero handles', async () => {
    const req = fakeKitRequest('/x')
    await composeHandles([], { headerPolicy: PV_HEADER_POLICY })({
      event: req.event,
      resolve: req.resolve,
    } as never)
    expect(req.setHeadersCalls).toHaveLength(1)
  })

  it('uses outsidePolicy headers instead of the policy when it returns a header map', async () => {
    const req = fakeKitRequest('/frozen/a')
    await composeHandles([], {
      headerPolicy: PV_HEADER_POLICY,
      outsidePolicy: ({ pathname }) => (pathname.startsWith('/frozen/') ? { 'x-a': '1' } : null),
    })({ event: req.event, resolve: req.resolve } as never)
    expect(req.setHeadersCalls).toEqual([{ 'x-a': '1' }])
  })

  it('sets nothing without a headerPolicy option', async () => {
    const req = fakeKitRequest('/x')
    await composeHandles([])({ event: req.event, resolve: req.resolve } as never)
    expect(req.setHeadersCalls).toEqual([])
  })

  it('a handle that setHeaders a policy header name throws "already set", loud (no catch)', async () => {
    const req = fakeKitRequest('/x')
    const handle = composeHandles(
      [
        ({ event, resolve }) => {
          event.setHeaders({ 'X-Frame-Options': 'SAMEORIGIN' })
          return resolve(event)
        },
      ],
      { headerPolicy: PV_HEADER_POLICY }
    )
    await expect(handle({ event: req.event, resolve: req.resolve } as never)).rejects.toThrow(
      '"X-Frame-Options" header is already set'
    )
  })
})
