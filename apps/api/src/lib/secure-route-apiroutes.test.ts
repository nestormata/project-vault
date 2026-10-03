import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import type { CapabilityGate } from '@project-vault/extension-api'
import { CapabilityId } from '@project-vault/shared'
import {
  loadedApiRoutesState,
  runStubRoute,
  stubDb,
  stubInstance,
  tableFor,
  type StubInstance,
  type StubRoute,
} from '../__tests__/helpers/secure-route-stubs.js'
import { __resetCapabilityGateForTests, wireExtensionCapabilityGate } from './capability-gate.js'
import {
  secureRoute,
  secureRoutes,
  type SecureRouteRegistration,
  type SecureRouteRegistrationOptions,
} from './secure-route.js'

const PROJECT_URL = '/:projectId'
const PROJECT_FULL_URL = '/api/v1/projects/:projectId'
const PROJECTS_PREFIX = '/api/v1/projects'
const DASHBOARD_PREFIX = '/api/v1/dashboard'
const DASHBOARD_KEY = 'GET /api/v1/dashboard'
const PROJECTS_KEY = 'GET /api/v1/projects'
const PROJECT_KEY = 'GET /api/v1/projects/:projectId'

function routeAt(instance: StubInstance, index: number): StubRoute {
  const route = instance.routes.at(index)
  if (!route) throw new Error(`no route registered at index ${index}`)
  return route
}

function register(instance: StubInstance, options: SecureRouteRegistrationOptions): void {
  secureRoute(instance as never, options)
}

function pvProjectRoute(handler = vi.fn(async () => ({ data: { id: 'pv' } }))) {
  const db = stubDb()
  return {
    handler,
    db,
    options: {
      method: 'GET',
      url: PROJECT_URL,
      db: { transaction: db.transaction },
      security: { writeAuditEvent: false },
      handler,
    } satisfies SecureRouteRegistrationOptions,
  }
}

describe('Story 68.8 AC-13 (a) — the secureRoutes registry is keyed by the prefixed route', () => {
  it('records METHOD prefix+url, so routes registered at url "" no longer collide', () => {
    for (const prefix of [DASHBOARD_PREFIX, PROJECTS_PREFIX]) {
      register(stubInstance({ prefix, orgRole: null }), {
        method: 'GET',
        url: '',
        security: { requireAuth: false, rateLimit: false },
        handler: async () => ({}),
      })
    }
    expect(secureRoutes.has(DASHBOARD_KEY)).toBe(true)
    expect(secureRoutes.has(PROJECTS_KEY)).toBe(true)
    expect(secureRoutes.has('GET ')).toBe(false)
  })
})

describe('Story 68.8 AC-18 — the default per-user rate-limit bucket key is the prefixed route key', () => {
  beforeEach(() => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  })
  afterEach(() => {
    delete process.env['RATE_LIMIT_TEST_BYPASS']
  })

  function publicRouteAt(prefix: string, url: string, rateLimit?: { max: number; key?: string }) {
    const instance = stubInstance({ prefix, orgRole: null })
    register(instance, {
      method: 'GET',
      url,
      security: { requireAuth: false, ...(rateLimit ? { rateLimit } : {}) },
      handler: async () => ({ ok: true }),
    })
    const route = instance.routes[0]
    if (!route) throw new Error('route not registered')
    return route
  }

  it('GET /api/v1/dashboard and GET /api/v1/projects no longer share the "GET " bucket', async () => {
    const ip = '198.51.100.18'
    const dashboard = publicRouteAt(DASHBOARD_PREFIX, '')
    const projects = publicRouteAt(PROJECTS_PREFIX, '')
    for (let index = 0; index < 60; index += 1) {
      const { reply } = await runStubRoute(dashboard, { ip })
      expect(reply.statusCode).toBe(200)
    }
    expect((await runStubRoute(projects, { ip })).reply.statusCode).toBe(200)
    expect((await runStubRoute(dashboard, { ip })).reply.statusCode).toBe(429)
  })

  it('GET /api/v1/auth/me and GET /api/v1/users/me no longer share the "GET /me" bucket', async () => {
    const ip = '198.51.100.19'
    const authMe = publicRouteAt('/api/v1/auth', '/me', { max: 1 })
    const usersMe = publicRouteAt('/api/v1/users', '/me', { max: 1 })
    expect((await runStubRoute(authMe, { ip })).reply.statusCode).toBe(200)
    expect((await runStubRoute(usersMe, { ip })).reply.statusCode).toBe(200)
    expect((await runStubRoute(authMe, { ip })).reply.statusCode).toBe(429)
  })

  it('an explicit rateLimit.key keeps its exact string, even an unprefixed one', async () => {
    const ip = '198.51.100.20'
    const callback = publicRouteAt('/api/v1/auth/sso', '/callback/:providerName', {
      max: 1,
      key: 'POST /callback',
    })
    const other = publicRouteAt('/api/v1/other', '/x', { max: 1, key: 'POST /callback' })
    expect((await runStubRoute(callback, { ip })).reply.statusCode).toBe(200)
    expect((await runStubRoute(other, { ip })).reply.statusCode).toBe(429)
  })

  it('records the effective key per registration in the per-app collector', () => {
    const registry = new Map<string, SecureRouteRegistration>()
    const explicit = stubInstance({ prefix: '/api/v1/admin', orgRole: null, registry })
    register(explicit, {
      method: 'DELETE',
      url: '/external-identities/:id',
      security: {
        requireAuth: false,
        writeAuditEvent: false,
        rateLimit: { max: 5, key: 'DELETE /api/v1/admin/external-identities' },
      },
      handler: async () => ({}),
    })
    register(stubInstance({ prefix: PROJECTS_PREFIX, orgRole: null, registry }), {
      method: 'GET',
      url: '',
      security: { requireAuth: false },
      handler: async () => ({}),
    })
    register(stubInstance({ prefix: '/health', orgRole: null, registry }), {
      method: 'GET',
      url: '',
      security: { requireAuth: false, rateLimit: false },
      handler: async () => ({}),
    })
    expect(registry.get('DELETE /api/v1/admin/external-identities/:id')).toMatchObject({
      rateLimitKey: 'DELETE /api/v1/admin/external-identities',
      rateLimitKeyIsDefault: false,
    })
    expect(registry.get(PROJECTS_KEY)).toMatchObject({
      rateLimitKey: 'GET /api/v1/projects',
      rateLimitKeyIsDefault: true,
      origin: 'pv',
    })
    expect(registry.get('GET /health')).toMatchObject({ rateLimitKey: null })
  })
})

describe('Story 68.8 AC-19 — the default audit eventType derivation is unchanged', () => {
  it('stays the unprefixed METHOD url and is recorded in the collector', () => {
    const registry = new Map<string, SecureRouteRegistration>()
    register(stubInstance({ prefix: '/api/v1/test', registry }), {
      method: 'POST',
      url: '/default-audit',
      handler: async () => ({}),
    })
    expect(registry.get('POST /api/v1/test/default-audit')?.defaultAuditEventType).toBe(
      'POST /default-audit'
    )
  })
})

describe('Story 68.8 AC-3 — no extension: route options are today’s plus the pvRoute marker', () => {
  it('registers the same options with config.pvRoute = { builtBy: "secureRoute" }', () => {
    const instance = stubInstance({ prefix: PROJECTS_PREFIX })
    const { options } = pvProjectRoute()
    register(instance, options)
    const [route] = instance.routes
    expect(Object.keys(route ?? {}).sort()).toEqual(
      ['attachValidation', 'config', 'handler', 'method', 'preHandler', 'schema', 'url'].sort()
    )
    expect(route?.config).toEqual({ pvRoute: { builtBy: 'secureRoute' } })
    expect(route?.url).toBe(PROJECT_URL)
    expect(route?.preHandler).toEqual([instance.authenticate])
  })
})

describe('Story 68.8 AC-3/AC-4 — replace and wrap swap only the business handler', () => {
  it('replace: CM handler runs inside PV pipeline with PV ctx; PV handler never runs; consumed', async () => {
    const cm = vi.fn(
      async (
        ctx: { auth: { orgId: string }; tx: unknown },
        req: { params: { projectId: string } }
      ) => ({
        data: {
          id: req.params.projectId,
          source: 'cm',
          org: ctx.auth.orgId,
          hasTx: Boolean(ctx.tx),
        },
      })
    )
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'replace' }] },
      {
        [PROJECT_KEY]: { handler: cm },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    const pv = pvProjectRoute()
    register(instance, pv.options)
    const route = routeAt(instance, 0)
    const { reply } = await runStubRoute(route, { params: { projectId: 'p1' } })
    expect(reply.body).toMatchObject({ data: { id: 'p1', source: 'cm', hasTx: true } })
    expect(pv.handler).not.toHaveBeenCalled()
    expect(pv.db.tx.execute).toHaveBeenCalled()
    expect(table.consumed.has(PROJECT_KEY)).toBe(true)
    expect(route.config?.pvRoute).toEqual({ builtBy: 'secureRoute', override: 'replace' })
  })

  it('replace without a session: 401 and CM handler never runs', async () => {
    const cm = vi.fn()
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'replace' }] },
      {
        [PROJECT_KEY]: { handler: cm },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    register(instance, pvProjectRoute().options)
    const route = routeAt(instance, 0)
    const reply = (await runStubRoute({ ...route, preHandler: [] })).reply
    expect(reply.statusCode).toBe(401)
    expect(cm).not.toHaveBeenCalled()
  })

  it('wrap: next() returns PV result and the wrap alters it', async () => {
    const cm = vi.fn(async (_ctx, _req, _reply, next: () => Promise<{ data: object }>) => {
      const pv = await next()
      return { data: { ...pv.data, cmTiles: [] } }
    })
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'wrap' }] },
      {
        [PROJECT_KEY]: { handler: cm },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    const pv = pvProjectRoute()
    register(instance, pv.options)
    const { reply } = await runStubRoute(routeAt(instance, 0))
    expect(reply.body).toEqual({ data: { id: 'pv', cmTiles: [] } })
    expect(pv.handler).toHaveBeenCalledOnce()
  })

  it('a wrap observes a PV handler that sent its own reply and does not send again', async () => {
    const pvHandler = vi.fn(
      async (
        _ctx: unknown,
        _req: unknown,
        reply: { status: (c: number) => { send: (b: unknown) => unknown } }
      ) => reply.status(422).send({ code: 'validation_failed' })
    )
    const seen: boolean[] = []
    const cm = vi.fn(async (_ctx, _req, reply: { sent: boolean }, next: () => Promise<unknown>) => {
      const result = await next()
      seen.push(reply.sent)
      return result
    })
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'wrap' }] },
      {
        [PROJECT_KEY]: { handler: cm },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    register(instance, pvProjectRoute(pvHandler as never).options)
    const { reply } = await runStubRoute(routeAt(instance, 0))
    expect(seen).toEqual([true])
    expect(reply.statusCode).toBe(422)
    expect(reply.body).toEqual({ code: 'validation_failed' })
  })

  it('the capability gate step still runs before a CM handler (swap point keeps the pipeline)', async () => {
    const order: string[] = []
    const gate: CapabilityGate['onCheckCapability'] = async () => {
      order.push('gate')
      return { permitted: true }
    }
    wireExtensionCapabilityGate(
      loadedApiRoutesState(undefined, {}, { capabilityGate: { onCheckCapability: gate } })
    )
    try {
      const cm = vi.fn(async () => {
        order.push('cm')
        return {}
      })
      const table = tableFor(
        { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'replace' }] },
        {
          [PROJECT_KEY]: { handler: cm },
        }
      )
      const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
      const pv = pvProjectRoute()
      register(instance, {
        ...pv.options,
        security: {
          writeAuditEvent: false,
          capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        },
      })
      await runStubRoute(routeAt(instance, 0))
      expect(order).toEqual(['gate', 'cm'])
    } finally {
      __resetCapabilityGateForTests()
    }
  })

  it('logs a pvRoute binding for every request an override answers', () => {
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'wrap' }] },
      {
        [PROJECT_KEY]: { handler: async () => ({}) },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    register(instance, pvProjectRoute().options)
    const onRequest = [instance.routes[0]?.onRequest].flat()[0] as (
      req: unknown,
      reply: unknown,
      done: () => void
    ) => void
    const child = vi.fn(() => ({ child: true }))
    const req = { log: { child } }
    const done = vi.fn()
    onRequest(req, {}, done)
    expect(done).toHaveBeenCalledOnce()
    expect(child).toHaveBeenCalledWith({ pvRoute: { override: 'wrap' } })
    expect(req.log).toEqual({ child: true })
  })
})

describe('Story 68.8 AC-5 — schema and route hooks on a secureRoute override', () => {
  it("'extend' merges the response schema and attachValidation follows the effective body", () => {
    const pvResponse = z.object({ data: z.object({ id: z.string() }) })
    const cmResponse = z.object({
      data: z.object({ id: z.string(), cmTiles: z.array(z.string()) }),
    })
    const cmBody = z.object({ note: z.string() })
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'wrap', schema: 'extend' }] },
      {
        [PROJECT_KEY]: {
          handler: async () => ({}),
          schema: { response: { 200: cmResponse }, body: cmBody },
        },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    const pvParams = z.object({ projectId: z.string() })
    register(instance, {
      ...pvProjectRoute().options,
      schema: { params: pvParams, response: { 200: pvResponse } },
    })
    const route = instance.routes[0]
    expect(route?.schema).toEqual({ params: pvParams, response: { 200: cmResponse }, body: cmBody })
    expect(route?.attachValidation).toBe(true)
  })

  it('prepended preHandlers run before authenticate and appended ones after it', () => {
    const before = vi.fn()
    const after = vi.fn()
    const table = tableFor(
      {
        override: [
          {
            method: 'GET',
            url: PROJECT_FULL_URL,
            mode: 'wrap',
            hooks: { prepend: ['preHandler'], append: ['preHandler', 'onSend'] },
          },
        ],
      },
      {
        [PROJECT_KEY]: {
          handler: async () => ({}),
          hooks: { preHandler: [before, after], onSend: after },
        },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    register(instance, pvProjectRoute().options)
    const route = instance.routes[0]
    expect(route?.preHandler).toEqual([before, after, instance.authenticate, before, after])
    expect(route?.onSend).toEqual([after])
  })
})

describe('Story 68.8 AC-6 — replaceSecurity replaces the route-level security and is never refused', () => {
  it('requireAuth: false yields a public CM handler with ctx = {}', async () => {
    const cm = vi.fn(async (ctx: unknown) => ({ ctx }))
    const table = tableFor(
      {
        override: [
          {
            method: 'GET',
            url: DASHBOARD_PREFIX,
            mode: 'replace',
            replaceSecurity: true,
            security: { requireAuth: false, rateLimit: false },
          },
        ],
      },
      { [DASHBOARD_KEY]: { handler: cm } }
    )
    const instance = stubInstance({ prefix: DASHBOARD_PREFIX, table })
    register(instance, {
      method: 'GET',
      url: '',
      security: { writeAuditEvent: false },
      handler: async () => ({}),
    })
    const route = routeAt(instance, 0)
    expect(route.preHandler).toEqual([])
    const { reply } = await runStubRoute(route)
    expect(reply.body).toEqual({ ctx: {} })
    expect(route.config?.pvRoute).toEqual({
      builtBy: 'secureRoute',
      override: 'replace',
      replaceSecurity: true,
    })
  })

  it('accepts a capability id PV does not know (Q14: passed through to the gate unchanged)', () => {
    const table = tableFor(
      {
        override: [
          {
            method: 'GET',
            url: DASHBOARD_PREFIX,
            mode: 'replace',
            replaceSecurity: true,
            security: { capability: 'cm.documents.read', requireOrgScope: false },
          },
        ],
      },
      { [DASHBOARD_KEY]: { handler: async () => ({}) } }
    )
    expect(() =>
      register(stubInstance({ prefix: DASHBOARD_PREFIX, table }), {
        method: 'GET',
        url: '',
        handler: async () => ({}),
      })
    ).not.toThrow()
  })

  it('a stricter security applies (viewer on an admin+MFA replacement gets 403)', async () => {
    const cm = vi.fn()
    const table = tableFor(
      {
        override: [
          {
            method: 'GET',
            url: DASHBOARD_PREFIX,
            mode: 'replace',
            replaceSecurity: true,
            security: {
              minimumRole: 'admin',
              requireMfa: true,
              requireOrgScope: false,
              writeAuditEvent: false,
            },
          },
        ],
      },
      { [DASHBOARD_KEY]: { handler: cm } }
    )
    const instance = stubInstance({ prefix: DASHBOARD_PREFIX, table, orgRole: 'viewer' })
    register(instance, { method: 'GET', url: '', handler: async () => ({}) })
    const { reply } = await runStubRoute(routeAt(instance, 0))
    expect(reply.statusCode).toBe(403)
    expect(cm).not.toHaveBeenCalled()
  })

  it('an incoherent effective config still fails registration with the route key', () => {
    const table = tableFor(
      {
        override: [
          {
            method: 'POST',
            url: DASHBOARD_PREFIX,
            mode: 'replace',
            replaceSecurity: true,
            security: { requireOrgScope: false, writeAuditEvent: true },
          },
        ],
      },
      { 'POST /api/v1/dashboard': { handler: async () => ({}) } }
    )
    expect(() =>
      register(stubInstance({ prefix: DASHBOARD_PREFIX, table }), {
        method: 'POST',
        url: '',
        handler: async () => ({}),
      })
    ).toThrow(
      'apiRoutes POST /api/v1/dashboard: SecureRoute: writeAuditEvent requires requireOrgScope'
    )
  })
})

describe('Story 68.8 AC-7 — HEAD', () => {
  it('a GET override reaches the auto-HEAD clone because the swap happens before route()', () => {
    const table = tableFor(
      { override: [{ method: 'GET', url: PROJECT_FULL_URL, mode: 'replace' }] },
      {
        [PROJECT_KEY]: { handler: async () => ({}) },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    register(instance, pvProjectRoute().options)
    expect(instance.routes).toHaveLength(1)
    expect(instance.routes[0]?.exposeHeadRoute).toBeUndefined()
  })

  it('an explicit HEAD override registers GET without auto-HEAD and a HEAD route through the same pipeline', async () => {
    const getSpy = vi.fn(async () => ({ get: true }))
    const headSpy = vi.fn(async () => ({ head: true }))
    const table = tableFor(
      {
        override: [
          { method: 'GET', url: PROJECT_FULL_URL, mode: 'replace' },
          { method: 'HEAD', url: PROJECT_FULL_URL, mode: 'replace' },
        ],
      },
      {
        [PROJECT_KEY]: { handler: getSpy },
        'HEAD /api/v1/projects/:projectId': { handler: headSpy },
      }
    )
    const instance = stubInstance({ prefix: PROJECTS_PREFIX, table })
    register(instance, pvProjectRoute().options)
    expect(instance.routes.map((route) => [route.method, route.exposeHeadRoute])).toEqual([
      ['GET', false],
      ['HEAD', undefined],
    ])
    const head = routeAt(instance, 1)
    expect(head.config?.pvRoute?.builtBy).toBe('secureRoute')
    await runStubRoute(head)
    expect(headSpy).toHaveBeenCalledOnce()
    expect(getSpy).not.toHaveBeenCalled()
    const unauthenticated = await runStubRoute({ ...head, preHandler: [] })
    expect(unauthenticated.reply.statusCode).toBe(401)
    expect(table.consumed).toEqual(new Set([PROJECT_KEY, 'HEAD /api/v1/projects/:projectId']))
  })

  it('HEAD and OPTIONS are accepted methods and get no default audit', () => {
    const registry = new Map<string, SecureRouteRegistration>()
    for (const method of ['HEAD', 'OPTIONS'] as const) {
      register(stubInstance({ registry }), { method, url: '/cm/x', handler: async () => ({}) })
    }
    expect(registry.get('HEAD /cm/x')?.defaultAuditEventType).toBeNull()
    expect(registry.get('OPTIONS /cm/x')?.defaultAuditEventType).toBeNull()
  })
})
