import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  buildSecurePreHandlers,
  secureRoute,
  secureRoutes,
  type SecureRouteOptions,
} from './secure-route.js'

const TEST_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000001'].join('-')

describe('buildSecurePreHandlers', () => {
  it('builds auth, org-role, then MFA preHandlers when requireMfa is true', () => {
    const authenticate = async () => undefined
    const fastify = { authenticate } as unknown as FastifyInstance
    const options: SecureRouteOptions = {
      requireOrgRole: ['owner', 'admin'],
      requireMfa: true,
    }

    const handlers = buildSecurePreHandlers(fastify, options)

    expect(handlers).toHaveLength(3)
    expect(handlers[0]).toBe(authenticate)
  })

  it('omits auth and MFA when explicitly disabled or unset', () => {
    const fastify = { authenticate: async () => undefined } as unknown as FastifyInstance

    expect(buildSecurePreHandlers(fastify, { requireAuth: false })).toHaveLength(0)
    expect(buildSecurePreHandlers(fastify, { requireOrgRole: ['owner'] })).toHaveLength(2)
  })
})

describe('secureRoute', () => {
  it('registers protected routes with secure defaults and a request-scoped transaction context', async () => {
    const authenticate = vi.fn(async (req: { authContext?: unknown }) => {
      req.authContext = {
        userId: 'user-1',
        orgId: TEST_ORG_ID,
        sessionId: 'session-1',
        jti: 'jti-1',
        sessionVersion: 1,
        orgRole: 'viewer',
      }
    })
    const execute = vi.fn()
    const tx = { execute }
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx))
    const route = vi.fn()
    const fastify = {
      authenticate,
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyInstance
    const handler = vi.fn(async (ctx) => ({ orgId: ctx.auth.orgId, tx: ctx.tx }))

    secureRoute(fastify, {
      method: 'GET',
      url: '/api/v1/test/defaults',
      db: { transaction },
      handler,
    })

    const registered = route.mock.calls[0]?.[0] as {
      preHandler: Array<(req: unknown, reply: unknown) => Promise<unknown>>
      handler: (req: unknown, reply: unknown) => Promise<unknown>
    }
    const req = { authContext: undefined }
    const reply = { sent: false, send: vi.fn((body) => body), status: vi.fn(() => reply) }
    for (const preHandler of registered.preHandler) {
      await preHandler(req, reply)
    }
    await registered.handler(req, reply)

    expect(authenticate).toHaveBeenCalledOnce()
    expect(transaction).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) })
    )
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ orgId: TEST_ORG_ID }),
        tx,
      }),
      req,
      reply
    )
    expect(secureRoutes.has('GET /api/v1/test/defaults')).toBe(true)
  })

  it('requires explicit public opt-outs and does not create fake auth or tx context', async () => {
    const route = vi.fn()
    const fastify = {
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyInstance
    const handler = vi.fn(async (ctx) => ctx)

    secureRoute(fastify, {
      method: 'GET',
      url: '/health',
      security: {
        requireAuth: false,
        requireOrgScope: false,
        writeAuditEvent: false,
        rateLimit: false,
      },
      handler,
    })

    const registered = route.mock.calls[0]?.[0] as {
      preHandler: unknown[]
      handler: (req: unknown, reply: unknown) => Promise<unknown>
    }
    const reply = { sent: false, send: vi.fn((body) => body), status: vi.fn(() => reply) }
    await registered.handler({}, reply)

    expect(registered.preHandler).toEqual([])
    expect(handler).toHaveBeenCalledWith({}, {}, reply)
  })

  it('throws at registration when auth is required but the auth plugin is missing', () => {
    const route = vi.fn()
    const fastify = {
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyInstance

    expect(() =>
      secureRoute(fastify, {
        method: 'GET',
        url: '/api/v1/test/missing-auth',
        handler: async () => ({}),
      })
    ).toThrow('SecureRoute: requireAuth is true but fastify.authenticate is not registered')
  })

  it('enforces role hierarchy before the handler runs', async () => {
    const authenticate = vi.fn(async (req: { authContext?: unknown }) => {
      req.authContext = {
        userId: 'user-1',
        orgId: TEST_ORG_ID,
        sessionId: 'session-1',
        jti: 'jti-1',
        sessionVersion: 1,
        orgRole: 'member',
      }
    })
    const route = vi.fn()
    const fastify = {
      authenticate,
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyInstance
    const handler = vi.fn()

    secureRoute(fastify, {
      method: 'GET',
      url: '/api/v1/test/admin-only',
      security: { minimumRole: 'admin', requireOrgScope: false, writeAuditEvent: false },
      handler,
    })

    const registered = route.mock.calls[0]?.[0] as {
      preHandler: Array<(req: unknown, reply: unknown) => Promise<unknown>>
      handler: (req: unknown, reply: unknown) => Promise<unknown>
    }
    const req = { authContext: undefined }
    const reply = {
      sent: false,
      statusCode: 200,
      status: vi.fn((code: number) => {
        reply.statusCode = code
        return reply
      }),
      send: vi.fn((body) => {
        reply.sent = true
        return body
      }),
    }
    for (const preHandler of registered.preHandler) {
      await preHandler(req, reply)
    }
    await registered.handler(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'insufficient_role',
      message: 'Insufficient permissions',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not send a success response when audit writing fails after handler result generation', async () => {
    const authenticate = vi.fn(async (req: { authContext?: unknown }) => {
      req.authContext = {
        userId: 'user-1',
        orgId: TEST_ORG_ID,
        sessionId: 'session-1',
        jti: 'jti-1',
        sessionVersion: 1,
        orgRole: 'owner',
      }
    })
    const tx = { execute: vi.fn() }
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx))
    const route = vi.fn()
    const auditWriter = vi.fn(async () => {
      throw new Error('audit unavailable')
    })
    const fastify = {
      authenticate,
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyInstance
    const handler = vi.fn(async () => ({ data: { changed: true } }))

    secureRoute(fastify, {
      method: 'POST',
      url: '/api/v1/test/audit-failure',
      db: { transaction },
      auditWriter,
      security: {
        writeAuditEvent: { eventType: 'test.audit_failure', resourceType: 'test' },
      },
      handler,
    })

    const registered = route.mock.calls[0]?.[0] as {
      preHandler: Array<(req: unknown, reply: unknown) => Promise<unknown>>
      handler: (req: unknown, reply: unknown) => Promise<unknown>
    }
    const req = { authContext: undefined, ip: '127.0.0.1', headers: {} }
    const reply = {
      sent: false,
      statusCode: 200,
      status: vi.fn((code: number) => {
        reply.statusCode = code
        return reply
      }),
      send: vi.fn((body) => {
        reply.sent = true
        return body
      }),
    }
    for (const preHandler of registered.preHandler) {
      await preHandler(req, reply)
    }
    await registered.handler(req, reply)

    expect(handler).toHaveBeenCalledOnce()
    expect(auditWriter).toHaveBeenCalledWith(
      expect.objectContaining({ tx, auth: expect.objectContaining({ userId: 'user-1' }) })
    )
    expect(reply.statusCode).toBe(503)
    expect(reply.send).toHaveBeenCalledTimes(1)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'audit_write_failed',
      message: 'Audit logging is unavailable',
    })
  })
})
