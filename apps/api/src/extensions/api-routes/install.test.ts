import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { loadedApiRoutesState } from '../../__tests__/helpers/secure-route-stubs.js'
import { ExtensionApiRouteBootError } from '../../lib/secure-route-overrides.js'
import { secureRoute } from '../../lib/secure-route.js'
import type { ExtensionState } from '../loader.js'
import { apiRoutesStatus, installApiRoutes, registerApiRouteAdds } from './install.js'

const PROJECTS = '/api/v1/projects'
const PROJECT = '/api/v1/projects/:projectId'
const SECRET_SOURCE_MARKER = 'cm-handler-source-marker'

const CALLBACK_KEY = 'POST /callback'
const WEBHOOK_KEY = 'POST /cm/webhooks/:provider'

type Logger = { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn() }
}

const handler = async () => ({ marker: SECRET_SOURCE_MARKER })

/** Boots a DB-free Fastify with apiRoutes installed the way createApp() does. */
async function boot(
  state: ExtensionState,
  registerPv: (app: FastifyInstance) => void | Promise<void>,
  options: { docsEnabled?: boolean } = {}
): Promise<{ app: FastifyInstance; log: Logger; runtime: ReturnType<typeof installApiRoutes> }> {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.decorate('authenticate', async (req: FastifyRequest) => {
    ;(req as FastifyRequest & { authContext?: unknown }).authContext = undefined
  })
  const runtime = installApiRoutes(app as never, state)
  await registerPv(app)
  const log = logger()
  await registerApiRouteAdds(app as never, runtime, {
    logger: log as never,
    docsEnabled: options.docsEnabled ?? true,
  })
  return { app, log, runtime }
}

function pvRoutes(app: FastifyInstance): void {
  void app.register(
    async (instance) => {
      secureRoute(instance as never, {
        method: 'GET',
        url: '',
        security: { requireAuth: false },
        handler: async () => ({ pv: 'list' }),
      })
      secureRoute(instance as never, {
        method: 'GET',
        url: '/:projectId',
        security: { requireAuth: false },
        handler: async () => ({ pv: 'one' }),
      })
      secureRoute(instance as never, {
        method: 'POST',
        url: '/callback',
        security: {
          requireAuth: false,
          writeAuditEvent: false,
          rateLimit: { max: 5, key: CALLBACK_KEY },
        },
        handler: async () => ({}),
      })
    },
    { prefix: PROJECTS }
  )
}

async function bootError(
  state: ExtensionState,
  docsEnabled = true
): Promise<ExtensionApiRouteBootError> {
  let caught: unknown
  try {
    const { app } = await boot(
      state,
      async (app) => {
        pvRoutes(app)
        await app.after()
      },
      { docsEnabled }
    )
    await app.close()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ExtensionApiRouteBootError)
  return caught as ExtensionApiRouteBootError
}

function routesFor(keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, { handler }]))
}

describe('Story 68.8 AC-10 — the add plugin', () => {
  it('registers added routes through secureRoute, anywhere, with the pvRoute marker', async () => {
    const state = loadedApiRoutesState(
      {
        add: [
          {
            method: 'POST',
            url: '/cm/webhooks/:provider',
            options: { security: { requireAuth: false, writeAuditEvent: false } },
          },
          {
            method: 'PUT',
            url: PROJECT,
            options: { security: { requireAuth: false, writeAuditEvent: false } },
          },
        ],
      },
      routesFor([WEBHOOK_KEY, `PUT ${PROJECT}`])
    )
    const { app, runtime } = await boot(state, async (instance) => {
      pvRoutes(instance)
      await instance.after()
    })
    const res = await app.inject({ method: 'POST', url: '/cm/webhooks/stripe' })
    expect(res.json()).toEqual({ marker: SECRET_SOURCE_MARKER })
    expect((await app.inject({ method: 'PUT', url: `${PROJECTS}/p1` })).statusCode).toBe(200)
    expect(runtime.registry.get(WEBHOOK_KEY)).toMatchObject({
      origin: 'added',
      rateLimitKey: WEBHOOK_KEY,
    })
    await app.close()
  })

  it('an added GET + HEAD pair at a new URL boots (HEAD registered before GET)', async () => {
    const headHandler = vi.fn(
      async (_ctx: unknown, _req: unknown, reply: { header: (n: string, v: string) => void }) => {
        reply.header('x-cm-head', '1')
        return ''
      }
    )
    const state = loadedApiRoutesState(
      {
        add: [
          { method: 'GET', url: '/cm/x', options: { security: { requireAuth: false } } },
          { method: 'HEAD', url: '/cm/x', options: { security: { requireAuth: false } } },
        ],
      },
      { 'GET /cm/x': { handler }, 'HEAD /cm/x': { handler: headHandler } }
    )
    const { app } = await boot(state, () => undefined)
    const head = await app.inject({ method: 'HEAD', url: '/cm/x' })
    expect(head.headers['x-cm-head']).toBe('1')
    expect(headHandler).toHaveBeenCalledOnce()
    await app.close()
  })

  it('an added OPTIONS route is more specific than a catch-all OPTIONS *', async () => {
    const state = loadedApiRoutesState(
      { add: [{ method: 'OPTIONS', url: '/cm/x', options: { security: { requireAuth: false } } }] },
      { 'OPTIONS /cm/x': { handler } }
    )
    const { app } = await boot(state, (instance) => {
      instance.options('*', async () => ({ cors: true }))
    })
    expect((await app.inject({ method: 'OPTIONS', url: '/cm/x' })).json()).toEqual({
      marker: SECRET_SOURCE_MARKER,
    })
    await app.close()
  })

  it('an undeclared collision fails the boot with the override hint, never FST_ERR_DUPLICATED_ROUTE', async () => {
    const error = await bootError(
      loadedApiRoutesState(
        { add: [{ method: 'GET', url: PROJECTS }] },
        routesFor([`GET ${PROJECTS}`])
      )
    )
    expect(error.reason).toBe('extension_api_route_collision')
    expect(error.message).toBe(
      "apiRoutes.add GET /api/v1/projects collides with an existing route; declare it under apiRoutes.override with mode 'replace' or 'wrap' to change it"
    )
  })

  it('an added HEAD where PV serves GET collides with the auto-HEAD route', async () => {
    const error = await bootError(
      loadedApiRoutesState(
        { add: [{ method: 'HEAD', url: PROJECT }] },
        routesFor([`HEAD ${PROJECT}`])
      )
    )
    expect(error.reason).toBe('extension_api_route_collision')
  })

  it('every unconsumed override fails the boot, sorted, with same-shape hints', async () => {
    const error = await bootError(
      loadedApiRoutesState(
        {
          override: [
            { method: 'PATCH', url: '/api/v1/nope', mode: 'replace' },
            { method: 'GET', url: '/api/v1/projects/:id', mode: 'replace' },
          ],
        },
        routesFor(['PATCH /api/v1/nope', 'GET /api/v1/projects/:id'])
      )
    )
    expect(error.reason).toBe('extension_api_route_drift')
    expect(error.message).toBe(
      'apiRoutes.override targets not found: GET /api/v1/projects/:id (PV has GET /api/v1/projects/:projectId), PATCH /api/v1/nope (no PV route); the API cannot start with a partially applied extension'
    )
    expect(error.message).not.toContain(SECRET_SOURCE_MARKER)
  })

  it('a docs-gated target names ENABLE_API_DOCS when docs are disabled', async () => {
    const error = await bootError(
      loadedApiRoutesState(
        { override: [{ method: 'GET', url: '/api/v1/docs/json', mode: 'replace' }] },
        routesFor(['GET /api/v1/docs/json'])
      ),
      false
    )
    expect(error.message).toContain(
      'GET /api/v1/docs/json (no PV route; registered only when API docs are enabled: ENABLE_API_DOCS)'
    )
  })
})

describe('Story 68.8 AC-6 — recording: boot log lines and the status summary', () => {
  const declaration = {
    add: [
      {
        method: 'GET',
        url: '/cm/a',
        options: { security: { requireOrgScope: false, capability: 'cm.read' } },
      },
    ],
    override: [
      {
        method: 'GET',
        url: PROJECTS,
        mode: 'replace',
        replaceSecurity: true,
        security: { requireAuth: false, rateLimit: false },
      },
      {
        method: 'GET',
        url: PROJECT,
        mode: 'wrap',
        schema: 'extend',
        hooks: { append: ['onSend'] },
      },
    ],
  }
  const implementations = {
    'GET /cm/a': { handler },
    [`GET ${PROJECTS}`]: { handler },
    [`GET ${PROJECT}`]: {
      handler,
      schema: {},
      hooks: { onSend: async (_r: unknown, _p: unknown, payload: unknown) => payload },
    },
  }

  it('logs one summary and one replace_security warn per route, keys only', async () => {
    const { app, log } = await boot(
      loadedApiRoutesState(declaration, implementations),
      async (instance) => {
        pvRoutes(instance)
        await instance.after()
      }
    )
    const summary = log.info.mock.calls.find(
      ([payload]) => payload.eventType === OperationalEvent.EXTENSION_API_ROUTES_APPLIED
    )
    expect(summary?.[0]).toMatchObject({
      extensionName: 'com.acme.api-routes',
      added: ['GET /cm/a'],
      overrides: [
        {
          key: 'GET /api/v1/projects',
          mode: 'replace',
          replaceSecurity: true,
          target: 'secureRoute',
        },
        {
          key: 'GET /api/v1/projects/:projectId',
          mode: 'wrap',
          replaceSecurity: false,
          schema: 'extend',
          target: 'secureRoute',
        },
      ],
    })
    const replaceSecurity = log.warn.mock.calls.filter(
      ([payload]) => payload.eventType === OperationalEvent.EXTENSION_API_ROUTE_REPLACE_SECURITY
    )
    expect(replaceSecurity).toHaveLength(1)
    expect(replaceSecurity[0]?.[0]).toMatchObject({
      extensionName: 'com.acme.api-routes',
      method: 'GET',
      url: PROJECTS,
      mode: 'replace',
    })
    const serialized = JSON.stringify([log.info.mock.calls, log.warn.mock.calls])
    expect(serialized).not.toContain(SECRET_SOURCE_MARKER)
    expect(serialized).not.toContain('payload')
    await app.close()
  })

  it('the status summary lists added and overridden routes with declaration data only', async () => {
    const { app, runtime } = await boot(
      loadedApiRoutesState(declaration, implementations),
      async (instance) => {
        pvRoutes(instance)
        await instance.after()
      }
    )
    expect(apiRoutesStatus(runtime.table)).toEqual({
      app: { errorHandler: null, notFoundHandler: null, hooks: { prepend: [], append: [] } },
      added: [{ method: 'GET', url: '/cm/a', capability: 'cm.read' }],
      overrides: [
        {
          method: 'GET',
          url: PROJECTS,
          mode: 'replace',
          replaceSecurity: true,
          target: 'secureRoute',
        },
        {
          method: 'GET',
          url: PROJECT,
          mode: 'wrap',
          replaceSecurity: false,
          schema: 'extend',
          hooks: { append: ['onSend'] },
          target: 'secureRoute',
        },
      ],
    })
    expect(apiRoutesStatus(undefined)).toEqual({
      added: [],
      overrides: [],
      app: { errorHandler: null, notFoundHandler: null, hooks: { prepend: [], append: [] } },
    })
    await app.close()
  })

  it('no summary line for a pack without apiRoutes (old pack: no new log line)', async () => {
    const { app, log } = await boot(
      {
        status: 'loaded',
        manifest: { name: 'com.acme.old', apiVersion: '3.25.0', capabilities: [] },
        hooks: {},
        loadedAt: '',
      },
      () => undefined
    )
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('Story 68.8 AC-18 — shared_default_key warn against PV explicit keys', () => {
  it('warns once when an added route lands in a PV route’s explicit bucket', async () => {
    const { app, log } = await boot(
      loadedApiRoutesState(
        {
          add: [
            {
              method: 'POST',
              url: '/callback',
              options: { security: { requireAuth: false, writeAuditEvent: false } },
            },
          ],
        },
        routesFor([CALLBACK_KEY])
      ),
      async (instance) => {
        pvRoutes(instance)
        await instance.after()
      }
    )
    const warns = log.warn.mock.calls.filter(
      ([payload]) => payload.eventType === OperationalEvent.EXTENSION_API_ROUTE_SHARED_DEFAULT_KEY
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.[0]).toMatchObject({
      route: CALLBACK_KEY,
      rateLimitKey: CALLBACK_KEY,
      sharedWith: 'POST /api/v1/projects/callback',
    })
    await app.close()
  })
})

describe('Story 71.3 AC-1 — a declared security.delegation installs the delegated stages', () => {
  const AUDIT_URL = '/cm/audit-events'
  const AUDIT_KEY = `POST ${AUDIT_URL}`

  async function bootAudit(delegation: boolean | undefined, handlerSpy: () => unknown) {
    const security = {
      capability: 'cm.audit',
      writeAuditEvent: false,
      ...(delegation === undefined ? {} : { delegation }),
    }
    const declaration = {
      add: [{ method: 'POST', url: AUDIT_URL, options: { security } }],
    }
    const state = loadedApiRoutesState(declaration as never, {
      [AUDIT_KEY]: { handler: handlerSpy },
    })
    return boot(state, async (instance) => {
      pvRoutes(instance)
      await instance.after()
    })
  }

  it('answers a request without an assertion with the generic delegation 401 (no session fallback), never calls the handler, and leaves the status envelope unchanged', async () => {
    const delegatedSpy = vi.fn(async () => ({ marker: SECRET_SOURCE_MARKER }))
    const plainSpy = vi.fn(async () => ({ marker: SECRET_SOURCE_MARKER }))
    const withDelegation = await bootAudit(true, delegatedSpy)
    const plain = await bootAudit(undefined, plainSpy)

    expect(withDelegation.runtime.registry.get(AUDIT_KEY)).toMatchObject({
      origin: 'added',
      delegation: true,
    })
    expect(plain.runtime.registry.get(AUDIT_KEY)).toMatchObject({ delegation: false })
    const res = await withDelegation.app.inject({ method: 'POST', url: AUDIT_URL })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'delegation_invalid' })
    const plainRes = await plain.app.inject({ method: 'POST', url: AUDIT_URL })
    expect(plainRes.statusCode).toBe(401)
    expect(plainRes.json()).toMatchObject({ code: 'access_token_missing' })
    expect(delegatedSpy).not.toHaveBeenCalled()
    const status = JSON.stringify(apiRoutesStatus(withDelegation.runtime.table))
    expect(status).toBe(JSON.stringify(apiRoutesStatus(plain.runtime.table)))
    expect(status).not.toContain('delegation')
    await withDelegation.app.close()
    await plain.app.close()
  })

  it('tripwire: delegation is recorded only on routes that declared it', async () => {
    const { runtime, app } = await bootAudit(true, vi.fn())
    const flagged = [...runtime.registry.values()].filter((route) => route.delegation)
    expect(flagged.map((route) => route.key)).toEqual([AUDIT_KEY])
    for (const route of runtime.registry.values()) {
      expect(typeof route.delegation).toBe('boolean')
    }
    await app.close()
  })
})
