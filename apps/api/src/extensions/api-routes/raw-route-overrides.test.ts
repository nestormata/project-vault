import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { tableFor } from '../../__tests__/helpers/secure-route-stubs.js'
import type { ApiRouteTable } from '../../lib/secure-route-overrides.js'
import { installRawRouteOverrideHook } from './raw-route-overrides.js'

const HEALTH = '/health'
const HEALTH_KEY = `GET ${HEALTH}`

const SECURE_URL = '/cm/secure'
const CM_ON_REQUEST = 'cm-onRequest'
const POLICY_URL = '/api/v1/client-version-policy'
const SERVICE_ORGS_URL = '/api/v1/service/organizations'

type RawHandler = (req: FastifyRequest, reply: FastifyReply) => unknown

async function appWith(
  table: ApiRouteTable | undefined,
  register: (app: FastifyInstance) => void | Promise<void>
): Promise<{ app: FastifyInstance; index: Set<string> }> {
  const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.decorate('authenticate', async (req: FastifyRequest) => {
    if (req.headers['x-test-user'] !== 'yes') return
    ;(req as FastifyRequest & { authContext?: unknown }).authContext = {
      userId: 'u',
      orgId: 'o',
      sessionId: 's',
      jti: 'j',
      sessionVersion: 1,
      orgRole: 'member',
      isPlatformOperator: false,
    }
  })
  if (table) app.decorate('pvApiRouteOverrides', table)
  const index = installRawRouteOverrideHook(app as never, table)
  await register(app)
  await app.ready()
  return { app, index }
}

function pvHealth(app: FastifyInstance, handler?: RawHandler): void {
  app.get(HEALTH, handler ?? (async () => ({ status: 'ok' })))
}

describe('Story 68.8 AC-8 — root onRoute hook for raw routes', () => {
  it('no extension: raw route handlers are untouched (identity preserved)', async () => {
    const pv: RawHandler = async () => ({ status: 'ok' })
    const seen: unknown[] = []
    const { app, index } = await appWith(undefined, (instance) => {
      instance.addHook('onRoute', (options) => {
        seen.push(options.handler)
      })
      pvHealth(instance, pv)
    })
    expect(seen).toEqual([pv, pv])
    expect(index.has(HEALTH_KEY)).toBe(true)
    expect(index.has(`HEAD ${HEALTH}`)).toBe(true)
    await app.close()
  })

  it('replace on GET /health also answers HEAD /health (AC-7) with CM headers and no body', async () => {
    const cm = vi.fn(async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('x-cm', '1')
      return { status: 'cm' }
    })
    const table = tableFor(
      { override: [{ method: 'GET', url: HEALTH, mode: 'replace' }] },
      {
        [HEALTH_KEY]: { handler: cm },
      }
    )
    const { app } = await appWith(table, (instance) => pvHealth(instance))
    const get = await app.inject({ method: 'GET', url: HEALTH })
    expect(get.json()).toEqual({ status: 'cm' })
    const head = await app.inject({ method: 'HEAD', url: HEALTH })
    expect(head.headers['x-cm']).toBe('1')
    expect(head.body).toBe('')
    expect(table.consumed.has(HEALTH_KEY)).toBe(true)
    expect(table.targets.get(HEALTH_KEY)).toBe('raw')
    await app.close()
  })

  it('wrap with a response-schema extend adds a field PV handler did not return', async () => {
    const table = tableFor(
      { override: [{ method: 'GET', url: HEALTH, mode: 'wrap', schema: 'extend' }] },
      {
        [HEALTH_KEY]: {
          handler: async (_req: unknown, _reply: unknown, next: () => Promise<object>) => ({
            ...(await next()),
            cm: 'ok',
          }),
          schema: { response: { 200: z.object({ status: z.string(), cm: z.string() }) } },
        },
      }
    )
    const { app } = await appWith(table, (instance) => {
      instance.get(
        HEALTH,
        { schema: { response: { 200: z.object({ status: z.string() }) } } },
        async () => ({ status: 'ok' })
      )
    })
    expect((await app.inject({ method: 'GET', url: HEALTH })).json()).toEqual({
      status: 'ok',
      cm: 'ok',
    })
    await app.close()
  })

  it('an explicit HEAD override wins for HEAD; both entries are consumed', async () => {
    const getSpy = vi.fn(async () => ({ from: 'get' }))
    const headSpy = vi.fn(async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('x-head', 'cm')
      return ''
    })
    const table = tableFor(
      {
        override: [
          { method: 'GET', url: HEALTH, mode: 'replace' },
          { method: 'HEAD', url: HEALTH, mode: 'replace' },
        ],
      },
      { [HEALTH_KEY]: { handler: getSpy }, [`HEAD ${HEALTH}`]: { handler: headSpy } }
    )
    const { app } = await appWith(table, (instance) => pvHealth(instance))
    const head = await app.inject({ method: 'HEAD', url: HEALTH })
    expect(head.headers['x-head']).toBe('cm')
    expect(headSpy).toHaveBeenCalledOnce()
    expect(getSpy).not.toHaveBeenCalled()
    expect(table.consumed).toEqual(new Set([HEALTH_KEY, `HEAD ${HEALTH}`]))
    await app.close()
  })

  it('a GET override does not create a HEAD for a route registered with exposeHeadRoute: false', async () => {
    const table = tableFor(
      { override: [{ method: 'GET', url: HEALTH, mode: 'replace' }] },
      {
        [HEALTH_KEY]: { handler: async () => ({}) },
      }
    )
    const { app } = await appWith(table, (instance) => {
      instance.route({
        method: 'GET',
        url: HEALTH,
        exposeHeadRoute: false,
        handler: async () => ({}),
      })
    })
    expect((await app.inject({ method: 'HEAD', url: HEALTH })).statusCode).toBe(404)
    await app.close()
  })

  it('skips routes secureRoute already built (config.pvRoute.builtBy === "secureRoute")', async () => {
    const pv = vi.fn(async () => ({ from: 'pv' }))
    const table = tableFor(
      { override: [{ method: 'GET', url: SECURE_URL, mode: 'replace' }] },
      {
        [`GET ${SECURE_URL}`]: { handler: async () => ({ from: 'cm' }) },
      }
    )
    // A route carrying secureRoute's marker, as secureRoute registers it: the hook must leave it
    // alone even though the table has an entry for its key.
    const { app } = await appWith(table, (instance) => {
      instance.route({
        method: 'GET',
        url: SECURE_URL,
        config: { pvRoute: { builtBy: 'secureRoute' } },
        handler: pv,
      })
    })
    expect((await app.inject({ method: 'GET', url: SECURE_URL })).json()).toEqual({ from: 'pv' })
    expect(table.consumed.size).toBe(0)
    await app.close()
  })

  it('a raw wrap observes a PV handler that sent its own reply and does not send again', async () => {
    const seen: boolean[] = []
    const table = tableFor(
      { override: [{ method: 'POST', url: '/vault/x', mode: 'wrap' }] },
      {
        'POST /vault/x': {
          handler: async (_req: unknown, reply: FastifyReply, next: () => Promise<unknown>) => {
            const result = await next()
            seen.push(reply.sent)
            return result
          },
        },
      }
    )
    const { app } = await appWith(table, (instance) => {
      instance.post('/vault/x', (_req, reply) => reply.status(400).send({ code: 'bad_request' }))
    })
    const res = await app.inject({ method: 'POST', url: '/vault/x' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ code: 'bad_request' })
    expect(seen).toEqual([true])
    await app.close()
  })

  it('prepends and appends route hooks around PV hooks of the same phase, in order', async () => {
    const order: string[] = []
    const table = tableFor(
      {
        override: [
          {
            method: 'GET',
            url: HEALTH,
            mode: 'wrap',
            hooks: { prepend: ['onRequest'], append: ['onRequest', 'onSend'] },
          },
        ],
      },
      {
        [HEALTH_KEY]: {
          handler: async (_req: unknown, _reply: unknown, next: () => Promise<unknown>) => next(),
          hooks: {
            onRequest: async (_req: FastifyRequest, reply: FastifyReply) => {
              order.push(CM_ON_REQUEST)
              reply.header('x-cm-hook', 'yes')
            },
            onSend: async (_req: unknown, _reply: unknown, payload: string) => {
              order.push('cm-onSend')
              return payload.replace('ok', 'rewritten')
            },
          },
        },
      }
    )
    const { app } = await appWith(table, (instance) => {
      instance.route({
        method: 'GET',
        url: HEALTH,
        onRequest: async () => {
          order.push('pv-onRequest')
        },
        handler: async () => ({ status: 'ok' }),
      })
    })
    const res = await app.inject({ method: 'GET', url: HEALTH })
    expect(res.headers['x-cm-hook']).toBe('yes')
    expect(res.json()).toEqual({ status: 'rewritten' })
    expect(order).toEqual([CM_ON_REQUEST, 'pv-onRequest', CM_ON_REQUEST, 'cm-onSend'])
    await app.close()
  })

  it('replaceSecurity on a raw route builds the secureRoute pipeline around CM handler (AC-6 raw edge)', async () => {
    const cm = vi.fn(async (ctx: unknown) => ({ ctx }))
    const pvPreHandler = vi.fn(async (_req: unknown, reply: FastifyReply) =>
      reply.status(418).send({})
    )
    const table = tableFor(
      {
        override: [
          {
            method: 'GET',
            url: POLICY_URL,
            mode: 'replace',
            replaceSecurity: true,
            security: { requireAuth: false, rateLimit: false },
          },
        ],
      },
      { [`GET ${POLICY_URL}`]: { handler: cm } }
    )
    let seenConfig: Record<string, unknown> | undefined
    const { app } = await appWith(table, (instance) => {
      instance.addHook('onRequest', async (req) => {
        seenConfig = (req.routeOptions.config ?? {}) as unknown as Record<string, unknown>
      })
      instance.route({
        method: 'GET',
        url: POLICY_URL,
        config: { rateLimit: { max: 1 } },
        preHandler: pvPreHandler,
        handler: async () => ({ pv: true }),
      })
    })
    const res = await app.inject({ method: 'GET', url: POLICY_URL })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ctx: {} })
    expect(pvPreHandler).not.toHaveBeenCalled()
    expect(seenConfig?.['rateLimit']).toBeUndefined()
    expect(seenConfig?.['pvRoute']).toEqual({
      builtBy: 'onRoute',
      override: 'replace',
      replaceSecurity: true,
    })
    await app.close()
  })

  it('without replaceSecurity, PV route-level preHandlers and config stay; only the handler is swapped', async () => {
    const table = tableFor(
      { override: [{ method: 'POST', url: SERVICE_ORGS_URL, mode: 'replace' }] },
      {
        [`POST ${SERVICE_ORGS_URL}`]: { handler: async () => ({ from: 'cm' }) },
      }
    )
    const pvPreHandler = vi.fn(async () => undefined)
    let seenConfig: Record<string, unknown> | undefined
    const { app } = await appWith(table, (instance) => {
      instance.addHook('onRequest', async (req) => {
        seenConfig = (req.routeOptions.config ?? {}) as unknown as Record<string, unknown>
      })
      instance.route({
        method: 'POST',
        url: SERVICE_ORGS_URL,
        config: { rateLimit: { max: 10 } },
        preHandler: pvPreHandler,
        handler: async () => ({ from: 'pv' }),
      })
    })
    const res = await app.inject({ method: 'POST', url: SERVICE_ORGS_URL })
    expect(res.json()).toEqual({ from: 'cm' })
    expect(pvPreHandler).toHaveBeenCalledOnce()
    expect(seenConfig?.['rateLimit']).toEqual({ max: 10 })
    expect(seenConfig?.['pvRoute']).toEqual({ builtBy: 'onRoute', override: 'replace' })
    await app.close()
  })
})
