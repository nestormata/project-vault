import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import type { ExtensionState } from '../extensions/loader.js'
import {
  ExtensionApiRouteBootError,
  assertHostAcceptsApiRouteSchemas,
  buildApiRouteTable,
  collectRouteHookFunctions,
  isHostSchema,
  mergeRouteHooks,
  mergeRouteSchema,
  routeKey,
  takeOverride,
  wrapBusinessHandler,
  wrapRawHandler,
} from './secure-route-overrides.js'

function loadedState(apiRoutes: unknown, routes: Record<string, unknown>): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.acme.api-routes',
      apiVersion: '3.27.0',
      capabilities: [],
      apiRoutes,
    },
    hooks: { apiRoutes: { routes } },
    loadedAt: new Date().toISOString(),
  } as unknown as ExtensionState
}

const handler = () => ({ ok: true })
const PROJECTS_URL = '/api/v1/projects'

describe('Story 68.8 AC-3 — routeKey normalization (method + prefix + url)', () => {
  it.each([
    ['GET', PROJECTS_URL, '', `GET ${PROJECTS_URL}`],
    ['GET', PROJECTS_URL, '/', `GET ${PROJECTS_URL}`],
    ['GET', PROJECTS_URL, '/:projectId', 'GET /api/v1/projects/:projectId'],
    ['GET', '', '/api/v1/projects/', `GET ${PROJECTS_URL}`],
    ['GET', '', '/', 'GET /'],
    ['GET', '', '', 'GET /'],
    ['POST', '/api/v1/auth', '/me', 'POST /api/v1/auth/me'],
    ['GET', '', '/billing/invoices/*', 'GET /billing/invoices/*'],
  ])('%s prefix=%j url=%j -> %s', (method, prefix, url, expected) => {
    expect(routeKey(method, prefix, url)).toBe(expected)
  })

  it('keeps distinct keys for the two routes that shared "GET " unprefixed', () => {
    expect(routeKey('GET', '/api/v1/dashboard', '')).not.toBe(routeKey('GET', PROJECTS_URL, ''))
  })
})

describe('Story 68.8 AC-3 — the per-app override table', () => {
  it('is undefined when no extension is loaded or no apiRoutes are declared', () => {
    expect(buildApiRouteTable({ status: 'not_configured' })).toBeUndefined()
    expect(
      buildApiRouteTable({ status: 'load_failed', reason: 'import_error' } as ExtensionState)
    ).toBeUndefined()
    expect(buildApiRouteTable(loadedState(undefined, {}))).toBeUndefined()
  })

  it('builds frozen entries keyed by the normalized route key and tracks consumption per app', () => {
    const table = buildApiRouteTable(
      loadedState(
        {
          override: [{ method: 'GET', url: '/api/v1/projects/', mode: 'replace' }],
          add: [{ method: 'GET', url: '/cm/x' }],
        },
        { 'GET /api/v1/projects/': { handler }, 'GET /cm/x': { handler } }
      )
    )
    expect(table).toBeDefined()
    const entry = table?.overrides.get(`GET ${PROJECTS_URL}`)
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(table?.adds)).toBe(true)
    expect(table?.adds[0]?.key).toBe('GET /cm/x')
    expect(table?.extensionName).toBe('com.acme.api-routes')

    expect(takeOverride(table, `GET ${PROJECTS_URL}`)).toBe(entry)
    expect(table?.consumed.has(`GET ${PROJECTS_URL}`)).toBe(true)
    expect(takeOverride(table, 'GET /nope')).toBeUndefined()
    expect(takeOverride(undefined, `GET ${PROJECTS_URL}`)).toBeUndefined()
  })

  it('two tables built from the same state never share consumption', () => {
    const state = loadedState(
      { override: [{ method: 'GET', url: '/x', mode: 'wrap' }] },
      {
        'GET /x': { handler },
      }
    )
    const first = buildApiRouteTable(state)
    const second = buildApiRouteTable(state)
    takeOverride(first, 'GET /x')
    expect(second?.consumed.size).toBe(0)
  })
})

describe('Story 68.8 AC-5 — schema merge', () => {
  const pv = { params: 'pv-params', body: 'pv-body', response: { 200: 'pv-200', 404: 'pv-404' } }

  it('without a mode keeps the PV schema', () => {
    expect(mergeRouteSchema(pv, { body: 'cm' }, undefined)).toBe(pv)
  })

  it("'replace' uses the CM schema verbatim", () => {
    const cm = { body: 'cm-body' }
    expect(mergeRouteSchema(pv, cm, 'replace')).toBe(cm)
  })

  it("'extend' merges per part and per response status, CM wins for parts it supplies", () => {
    expect(
      mergeRouteSchema(pv, { body: 'cm-body', response: { 200: 'cm-200' } }, 'extend')
    ).toEqual({
      params: 'pv-params',
      body: 'cm-body',
      response: { 200: 'cm-200', 404: 'pv-404' },
    })
  })

  it("'extend' over a route with no PV schema is the CM schema", () => {
    expect(mergeRouteSchema(undefined, { body: 'cm-body' }, 'extend')).toEqual({ body: 'cm-body' })
  })
})

describe('Story 68.8 AC-5 — route hook merge', () => {
  const pvHook = vi.fn()
  const cmBefore = vi.fn()
  const cmAfter = vi.fn()

  it('prepends and appends around PV hooks of the same phase', () => {
    expect(mergeRouteHooks(pvHook, [cmBefore], [cmAfter])).toEqual([cmBefore, pvHook, cmAfter])
    expect(mergeRouteHooks([pvHook], [], [cmAfter])).toEqual([pvHook, cmAfter])
    expect(mergeRouteHooks(undefined, [cmBefore], [])).toEqual([cmBefore])
  })

  it('returns the PV value untouched when nothing is added', () => {
    expect(mergeRouteHooks(pvHook, [], [])).toBe(pvHook)
    expect(mergeRouteHooks(undefined, [], [])).toBeUndefined()
  })

  it('collects declared phase functions from an implementation (single function or array)', () => {
    const implementation = { handler, hooks: { preHandler: cmBefore, onSend: [cmAfter, cmBefore] } }
    expect(collectRouteHookFunctions(implementation, ['preHandler'])).toEqual(
      new Map([['preHandler', [cmBefore]]])
    )
    expect(collectRouteHookFunctions(implementation, ['onSend', 'onRequest'])).toEqual(
      new Map([['onSend', [cmAfter, cmBefore]]])
    )
  })
})

describe('Story 68.8 AC-4 / Q9 — wrap and next()', () => {
  it('next() runs PV handler with the same arguments and returns its result', async () => {
    const pv = vi.fn(async () => ({ data: { id: 'p' } }))
    const cm = vi.fn(async (_ctx, _req, _reply, next: () => Promise<unknown>) => {
      const result = (await next()) as { data: object }
      return { data: { ...result.data, cmTiles: [] } }
    })
    const wrapped = wrapBusinessHandler('GET /x', cm, pv)
    const ctx = { auth: {} }
    await expect(wrapped(ctx, 'req', 'reply')).resolves.toEqual({ data: { id: 'p', cmTiles: [] } })
    expect(pv).toHaveBeenCalledWith(ctx, 'req', 'reply')
  })

  it('a wrap that never calls next() behaves like replace', async () => {
    const pv = vi.fn()
    const wrapped = wrapBusinessHandler('GET /x', async () => 'cm-only', pv)
    await expect(wrapped({}, 'req', 'reply')).resolves.toBe('cm-only')
    expect(pv).not.toHaveBeenCalled()
  })

  it('next() twice runs PV handler twice', async () => {
    const pv = vi.fn(async () => 1)
    const wrapped = wrapBusinessHandler(
      'GET /x',
      async (_c, _q, _r, next) => {
        await next()
        return next()
      },
      pv
    )
    await wrapped({}, 'req', 'reply')
    expect(pv).toHaveBeenCalledTimes(2)
  })

  it('next() after the wrap settled rejects and never runs PV handler', async () => {
    const pv = vi.fn()
    let stored: (() => Promise<unknown>) | undefined
    const wrapped = wrapBusinessHandler(
      'GET /api/v1/x',
      async (_c, _q, _r, next) => {
        stored = next
        return 'done'
      },
      pv
    )
    await wrapped({}, 'req', 'reply')
    await expect(stored?.()).rejects.toThrow(
      'apiRoutes wrap next() called after the handler settled: GET /api/v1/x'
    )
    expect(pv).not.toHaveBeenCalled()
  })

  it('a synchronous throw from PV handler reaches the wrap as a rejected next() promise', async () => {
    const boom = (): never => {
      throw new Error('pv boom')
    }
    const settle = (next: () => Promise<unknown>) =>
      next().then(
        () => 'resolved',
        (error: Error) => `rejected: ${error.message}`
      )
    const business = wrapBusinessHandler('GET /x', (_c, _q, _r, next) => settle(next), boom)
    await expect(business({}, 'req', 'reply')).resolves.toBe('rejected: pv boom')
    const raw = wrapRawHandler('GET /raw', (_req, _reply, next) => settle(next), boom)
    await expect(raw.call({}, 'req', 'reply')).resolves.toBe('rejected: pv boom')
  })

  it('a raw wrap passes the Fastify instance as this to PV handler', async () => {
    const instance = { name: 'fastify' }
    const pv = vi.fn(function (this: unknown) {
      return this
    })
    const wrapped = wrapRawHandler('GET /health', async (_req, _reply, next) => next(), pv)
    await expect(wrapped.call(instance, 'req', 'reply')).resolves.toBe(instance)
    let stored: (() => Promise<unknown>) | undefined
    const late = wrapRawHandler(
      'GET /health',
      (_req, _reply, next) => {
        stored = next
        return 'x'
      },
      pv
    )
    await late.call(instance, 'req', 'reply')
    await expect(stored?.()).rejects.toThrow('after the handler settled: GET /health')
  })
})

describe('Story 68.8 AC-3/AC-5 — eager schema check inside createApp()', () => {
  it('accepts Zod 4 schemas, including response maps', () => {
    expect(isHostSchema(z.object({ a: z.string() }))).toBe(true)
    expect(isHostSchema({ type: 'object' })).toBe(false)
    const table = buildApiRouteTable(
      loadedState(
        { add: [{ method: 'POST', url: '/cm/x', options: { schema: true } }] },
        {
          'POST /cm/x': {
            handler,
            schema: { body: z.object({ a: z.string() }), response: { 200: z.object({}) } },
          },
        }
      )
    )
    expect(() => assertHostAcceptsApiRouteSchemas(table)).not.toThrow()
    expect(() => assertHostAcceptsApiRouteSchemas(undefined)).not.toThrow()
  })

  it('rejects a schema part the host compiler does not accept, naming the route and part', () => {
    const table = buildApiRouteTable(
      loadedState(
        {
          override: [
            { method: 'GET', url: '/api/v1/projects/:projectId', mode: 'wrap', schema: 'extend' },
          ],
        },
        {
          'GET /api/v1/projects/:projectId': {
            handler,
            schema: { response: { 200: { type: 'object' } } },
          },
        }
      )
    )
    let caught: unknown
    try {
      assertHostAcceptsApiRouteSchemas(table)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ExtensionApiRouteBootError)
    expect((caught as ExtensionApiRouteBootError).reason).toBe(
      'extension_api_route_schema_rejected'
    )
    expect((caught as Error).message).toBe(
      'apiRoutes override GET /api/v1/projects/:projectId: schema rejected by the host compiler: response.200 is not a schema the host compiler accepts (expected a Zod 4 schema)'
    )
  })

  it('rejects a schema that is not an object of parts', () => {
    const table = buildApiRouteTable(
      loadedState(
        { add: [{ method: 'GET', url: '/cm/x', options: { schema: true } }] },
        { 'GET /cm/x': { handler, schema: 'nope' } }
      )
    )
    expect(() => assertHostAcceptsApiRouteSchemas(table)).toThrow(
      'apiRoutes add GET /cm/x: schema rejected by the host compiler: the schema must be an object of parts (params, querystring, body, headers, response)'
    )
  })
})
