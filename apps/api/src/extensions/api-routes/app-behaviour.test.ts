import { describe, expect, it, vi } from 'vitest'
import {
  appChangeLabels,
  appChanges,
  appSpecOf,
  appStatus,
  installAppHooks,
  pvNotFoundHandler,
  resolveErrorHandler,
  resolveNotFoundHandler,
  type AppBehaviourSpec,
} from './app-behaviour.js'
import { pvErrorHandler } from '../../lib/pv-error-handler.js'

/** Story 68.14 AC-1 — unit tests for the app-level behaviour shell (no Fastify, no DB). */

function replyRecorder(sent = false) {
  const calls: Array<[number, unknown]> = []
  const reply = {
    sent,
    status: (code: number) => ({
      send: (body: unknown) => {
        calls.push([code, body])
        return reply
      },
    }),
    code: (code: number) => ({
      send: (body: unknown) => {
        calls.push([code, body])
        return reply
      },
    }),
  }
  return { reply, calls }
}

function request() {
  const error = vi.fn()
  const info = vi.fn()
  return {
    req: {
      method: 'GET',
      url: '/x',
      routeOptions: { url: '/x' },
      raw: { method: 'GET', url: '/x' },
      ip: '203.0.113.1',
      headers: {},
      log: { error, info },
    },
    error,
    info,
  }
}

function spec(
  declaration: NonNullable<Parameters<typeof appSpecOf>[0]>['app'],
  implementation: Parameters<typeof appSpecOf>[1]
): AppBehaviourSpec {
  const built = appSpecOf({ app: declaration }, implementation)
  if (!built) throw new Error('spec expected')
  return built
}

describe('appSpecOf / appStatus / appChanges', () => {
  it('is undefined without an app declaration and all-empty in the status', () => {
    expect(appSpecOf(undefined, undefined)).toBeUndefined()
    expect(appSpecOf({}, undefined)).toBeUndefined()
    expect(appStatus(undefined)).toEqual({
      errorHandler: null,
      notFoundHandler: null,
      hooks: { prepend: [], append: [] },
    })
    expect(appChanges(undefined)).toEqual([])
  })

  it('lists every declared change in a stable order', () => {
    const built = spec(
      {
        errorHandler: 'wrap',
        notFoundHandler: 'replace',
        hooks: { prepend: ['onRequest'], append: ['onSend', 'preHandler'] },
      },
      {}
    )
    expect(appChangeLabels(built)).toEqual([
      'errorHandler wrap',
      'notFoundHandler replace',
      'hook onRequest prepend',
      'hook onSend append',
      'hook preHandler append',
    ])
    expect(appStatus(built).hooks).toEqual({
      prepend: ['onRequest'],
      append: ['onSend', 'preHandler'],
    })
  })

  it('an empty app object declares no change', () => {
    expect(appChanges(spec({}, undefined))).toEqual([])
  })
})

describe('installAppHooks', () => {
  it('adds each declared phase function (single or array) for the requested position only', () => {
    const fnA = () => undefined
    const fnB = () => undefined
    const added: Array<[string, unknown]> = []
    const host = { addHook: (name: string, hook: unknown) => added.push([name, hook]) }
    const built = spec(
      { hooks: { prepend: ['onRequest'], append: ['onSend'] } },
      { hooks: { onRequest: fnA, onSend: [fnA, fnB] } }
    )
    installAppHooks(host, built, 'prepend')
    expect(added).toEqual([['onRequest', fnA]])
    added.length = 0
    installAppHooks(host, built, 'append')
    expect(added).toEqual([
      ['onSend', fnA],
      ['onSend', fnB],
    ])
    added.length = 0
    installAppHooks(host, undefined, 'append')
    expect(added).toEqual([])
  })
})

describe('resolveErrorHandler', () => {
  it('returns PV handler unchanged when the extension declares none', () => {
    const pv = vi.fn()
    expect(resolveErrorHandler('x', undefined, pv)).toBe(pv)
    expect(resolveErrorHandler('x', spec({}, undefined), pv)).toBe(pv)
  })

  it('a delegating wrap answers byte-identical to PV for a 429 (route-scoped and bare)', async () => {
    const built = spec(
      { errorHandler: 'wrap' },
      { errorHandler: (_e: Error, _r: unknown, _p: unknown, next: () => unknown) => next() }
    )
    const handler = resolveErrorHandler('x', built)
    for (const error of [
      Object.assign(new Error('slow down'), { statusCode: 429, code: 'rate_limit_exceeded' }),
      Object.assign(new Error('x'), { statusCode: 429, ttl: 4500 }),
    ]) {
      const direct = replyRecorder()
      await pvErrorHandler(error, request().req as never, direct.reply as never)
      const wrapped = replyRecorder()
      await handler(error, request().req as never, wrapped.reply as never)
      expect(wrapped.calls).toEqual(direct.calls)
    }
  })

  it('replace: the extension answers and PV is not called', async () => {
    const pv = vi.fn()
    const cm = vi.fn(
      async (_e: Error, _r: unknown, reply: ReturnType<typeof replyRecorder>['reply']) =>
        reply.status(418).send({ cm: true })
    )
    const handler = resolveErrorHandler(
      'x',
      spec({ errorHandler: 'replace' }, { errorHandler: cm }),
      pv
    )
    const { reply, calls } = replyRecorder()
    await handler(new Error('e'), request().req as never, reply as never)
    expect(calls).toEqual([[418, { cm: true }]])
    expect(pv).not.toHaveBeenCalled()
  })

  it('a throwing extension falls back to PV with the original error and logs class only', async () => {
    const pv = vi.fn(async () => 'pv-answer')
    const handler = resolveErrorHandler(
      'ext',
      spec(
        { errorHandler: 'replace' },
        {
          errorHandler: () => {
            throw new RangeError('secret-looking text')
          },
        }
      ),
      pv
    )
    const original = new Error('original')
    const { req, error } = request()
    const { reply } = replyRecorder()
    await expect(handler(original, req as never, reply as never)).resolves.toBe('pv-answer')
    expect(pv).toHaveBeenCalledWith(original, req, reply)
    const [fields] = error.mock.calls[0] as [Record<string, unknown>]
    expect(fields).toEqual({
      eventType: 'extension.api_route.app_handler_failed',
      extensionName: 'ext',
      handler: 'errorHandler',
      route: 'GET /x',
      errorClass: 'RangeError',
    })
  })

  it('does not call PV again when the failing extension handler already sent a reply', async () => {
    const pv = vi.fn()
    const handler = resolveErrorHandler(
      'ext',
      spec(
        { errorHandler: 'wrap' },
        {
          errorHandler: async () => {
            throw new Error('late')
          },
        }
      ),
      pv
    )
    const { reply } = replyRecorder(true)
    await expect(handler(new Error('e'), request().req as never, reply as never)).resolves.toBe(
      reply
    )
    expect(pv).not.toHaveBeenCalled()
  })

  it('records a non-Error rejection by its typeof', async () => {
    const pv = vi.fn()
    const handler = resolveErrorHandler(
      'ext',
      spec(
        { errorHandler: 'replace' },
        { errorHandler: () => Promise.reject('plain string' as unknown as Error) }
      ),
      pv
    )
    const { req, error } = request()
    await handler(new Error('e'), req as never, replyRecorder().reply as never)
    expect((error.mock.calls[0] as [Record<string, unknown>])[0]['errorClass']).toBe('string')
  })

  it('records a null route when the request matched no route', async () => {
    const handler = resolveErrorHandler(
      'ext',
      spec({ errorHandler: 'replace' }, { errorHandler: () => Promise.reject(new Error('x')) }),
      vi.fn()
    )
    const { req, error } = request()
    await handler(
      new Error('e'),
      { ...req, routeOptions: {} } as never,
      replyRecorder().reply as never
    )
    expect((error.mock.calls[0] as [Record<string, unknown>])[0]['route']).toBeNull()
  })
})

describe('resolveNotFoundHandler / pvNotFoundHandler', () => {
  it('PV default logs Fastify message and answers the Fastify 404 body', () => {
    const { req, info } = request()
    const { reply, calls } = replyRecorder()
    pvNotFoundHandler(req as never, reply as never)
    expect(info).toHaveBeenCalledWith('Route GET:/x not found')
    expect(calls).toEqual([
      [404, { message: 'Route GET:/x not found', error: 'Not Found', statusCode: 404 }],
    ])
  })

  it('wrap delegates through next() to PV', async () => {
    const built = spec(
      { notFoundHandler: 'wrap' },
      { notFoundHandler: (_r: unknown, _p: unknown, next: () => unknown) => next() }
    )
    const { req } = request()
    const { reply, calls } = replyRecorder()
    await resolveNotFoundHandler('ext', built)(req as never, reply as never)
    expect(calls[0]?.[0]).toBe(404)
  })

  it('returns PV handler when nothing is declared and falls back when the extension throws', async () => {
    const pv = vi.fn(async () => 'pv')
    expect(resolveNotFoundHandler('ext', undefined, pv)).toBe(pv)
    const handler = resolveNotFoundHandler(
      'ext',
      spec(
        { notFoundHandler: 'replace' },
        { notFoundHandler: () => Promise.reject(new Error('x')) }
      ),
      pv
    )
    const { req, error } = request()
    await expect(handler(req as never, replyRecorder().reply as never)).resolves.toBe('pv')
    expect((error.mock.calls[0] as [Record<string, unknown>])[0]['handler']).toBe('notFoundHandler')
  })

  it('does not call PV when the failing handler already replied', async () => {
    const pv = vi.fn()
    const handler = resolveNotFoundHandler(
      'ext',
      spec(
        { notFoundHandler: 'replace' },
        { notFoundHandler: () => Promise.reject(new Error('x')) }
      ),
      pv
    )
    const { reply } = replyRecorder(true)
    await handler(request().req as never, reply as never)
    expect(pv).not.toHaveBeenCalled()
  })
})
