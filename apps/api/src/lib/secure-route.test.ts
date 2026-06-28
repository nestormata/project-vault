import { describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  buildSecurePreHandlers,
  secureRoute,
  secureRoutes,
  type SecureRouteOptions,
  type SecureRouteRegistrationOptions,
} from './secure-route.js'

const TEST_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000001'].join('-')

type RegisteredRoute = {
  preHandler: Array<(req: unknown, reply: unknown) => Promise<unknown>>
  handler: (req: unknown, reply: unknown) => Promise<unknown>
}

type ReplyMock = {
  sent: boolean
  statusCode: number
  status: ReturnType<typeof vi.fn>
  header: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

type TransactionFn = NonNullable<SecureRouteRegistrationOptions['db']>['transaction']

function authContext(orgRole = 'viewer'): Record<string, unknown> {
  return {
    userId: 'user-1',
    orgId: TEST_ORG_ID,
    sessionId: 'session-1',
    jti: 'jti-1',
    sessionVersion: 1,
    orgRole,
  }
}

function authenticateAs(orgRole = 'viewer'): ReturnType<typeof vi.fn> {
  return vi.fn(async (req: { authContext?: unknown }) => {
    req.authContext = authContext(orgRole)
  })
}

function fastifyStub(route: ReturnType<typeof vi.fn>, authenticate?: unknown): FastifyInstance {
  return {
    ...(authenticate ? { authenticate } : {}),
    route,
    withTypeProvider: () => ({ route }),
  } as unknown as FastifyInstance
}

function registeredRoute(route: ReturnType<typeof vi.fn>): RegisteredRoute {
  return route.mock.calls[0]?.[0] as RegisteredRoute
}

function replyMock(): ReplyMock {
  const reply = {
    sent: false,
    statusCode: 200,
    status: vi.fn((code: number) => {
      reply.statusCode = code
      return reply
    }),
    header: vi.fn(() => reply),
    send: vi.fn((body) => {
      reply.sent = true
      return body
    }),
  }
  return reply
}

function transactionHarness(tx = { execute: vi.fn() }): {
  tx: typeof tx
  transaction: TransactionFn
} {
  return {
    tx,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  }
}

function mountProtectedRoute(
  options: SecureRouteRegistrationOptions,
  orgRole = 'viewer'
): {
  authenticate: ReturnType<typeof vi.fn>
  registered: RegisteredRoute
  route: ReturnType<typeof vi.fn>
} {
  const authenticate = authenticateAs(orgRole)
  const route = vi.fn()
  secureRoute(fastifyStub(route, authenticate), options)
  return { authenticate, registered: registeredRoute(route), route }
}

function mountPublicRoute(options: SecureRouteRegistrationOptions): RegisteredRoute {
  const route = vi.fn()
  secureRoute(fastifyStub(route), options)
  return registeredRoute(route)
}

async function invokeRegisteredRoute(
  registered: RegisteredRoute,
  req: Record<string, unknown> = {},
  reply = replyMock()
): Promise<{ reply: ReplyMock; req: Record<string, unknown>; result: unknown }> {
  for (const preHandler of registered.preHandler) await preHandler(req, reply)
  const result = await registered.handler(req, reply)
  return { reply, req, result }
}

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
    const { tx, transaction } = transactionHarness()
    const handler = vi.fn(async (ctx) => ({ orgId: ctx.auth.orgId, tx: ctx.tx }))
    const { authenticate, registered } = mountProtectedRoute({
      method: 'GET',
      url: '/api/v1/test/defaults',
      db: { transaction },
      handler,
    })

    const req = { authContext: undefined }
    const reply = replyMock()
    await invokeRegisteredRoute(registered, req, reply)

    expect(authenticate).toHaveBeenCalledOnce()
    expect(transaction).toHaveBeenCalledOnce()
    expect(tx.execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) })
    )
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ orgId: TEST_ORG_ID }), tx }),
      req,
      reply
    )
    expect(secureRoutes.has('GET /api/v1/test/defaults')).toBe(true)
  })

  it('requires explicit public opt-outs and does not create fake auth or tx context', async () => {
    const handler = vi.fn(async (ctx) => ctx)
    const registered = mountPublicRoute({
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

    await registered.handler({}, replyMock())

    expect(registered.preHandler).toEqual([])
    expect(handler).toHaveBeenCalledWith({}, {}, expect.any(Object))
  })

  it('throws at registration when auth is required but the auth plugin is missing', () => {
    expect(() =>
      secureRoute(fastifyStub(vi.fn()), {
        method: 'GET',
        url: '/api/v1/test/missing-auth',
        handler: async () => ({}),
      })
    ).toThrow('SecureRoute: requireAuth is true but fastify.authenticate is not registered')
  })

  it('enforces role hierarchy before the handler runs', async () => {
    const handler = vi.fn()
    const { registered } = mountProtectedRoute(
      {
        method: 'GET',
        url: '/api/v1/test/admin-only',
        security: { minimumRole: 'admin', requireOrgScope: false, writeAuditEvent: false },
        handler,
      },
      'member'
    )

    const { reply } = await invokeRegisteredRoute(registered, { authContext: undefined })

    expect(reply.statusCode).toBe(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'insufficient_role',
      message: 'Insufficient permissions',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('fails closed when allowedRoles is explicitly empty', () => {
    expect(() =>
      secureRoute(
        fastifyStub(vi.fn(), async () => undefined),
        {
          method: 'GET',
          url: '/api/v1/test/empty-roles',
          security: { allowedRoles: [] },
          handler: async () => ({}),
        }
      )
    ).toThrow('SecureRoute: allowedRoles must not be empty')
  })

  it('defaults mutating protected routes to same-transaction audit writes', async () => {
    const { tx, transaction } = transactionHarness()
    const auditWriter = vi.fn(async () => undefined)
    const { registered } = mountProtectedRoute({
      method: 'POST',
      url: '/api/v1/test/default-audit',
      db: { transaction },
      auditWriter,
      handler: async () => ({ data: { ok: true } }),
    })

    await invokeRegisteredRoute(registered, {
      authContext: undefined,
      ip: '127.0.0.1',
      headers: {},
    })

    expect(auditWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        config: expect.objectContaining({ eventType: 'POST /api/v1/test/default-audit' }),
      })
    )
  })

  it('rejects audit configuration without an org-scoped transaction', () => {
    expect(() =>
      secureRoute(
        fastifyStub(vi.fn(), async () => undefined),
        {
          method: 'POST',
          url: '/api/v1/test/no-org-audit',
          security: {
            requireOrgScope: false,
            writeAuditEvent: { eventType: 'test.no_org_audit' },
          },
          handler: async () => ({}),
        }
      )
    ).toThrow('SecureRoute: writeAuditEvent requires requireOrgScope')
  })

  it('applies configured public SecureRoute rate limits', async () => {
    const handler = vi.fn(async () => ({ data: { ok: true } }))
    const registered = mountPublicRoute({
      method: 'GET',
      url: '/api/v1/test/public-limited',
      security: {
        requireAuth: false,
        requireOrgScope: false,
        writeAuditEvent: false,
        rateLimit: { max: 1, timeWindowMs: 60_000 },
      },
      handler,
    })

    await registered.handler({ ip: '127.0.0.1' }, replyMock())
    const secondReply = replyMock()
    await registered.handler({ ip: '127.0.0.1' }, secondReply)

    expect(secondReply.statusCode).toBe(429)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not send a success response when audit writing fails after handler result generation', async () => {
    const { tx, transaction } = transactionHarness()
    const auditWriter = vi.fn(async () => {
      throw new Error('audit unavailable')
    })
    const handler = vi.fn(async () => ({ data: { changed: true } }))
    const { registered } = mountProtectedRoute(
      {
        method: 'POST',
        url: '/api/v1/test/audit-failure',
        db: { transaction },
        auditWriter,
        security: {
          writeAuditEvent: { eventType: 'test.audit_failure', resourceType: 'test' },
        },
        handler,
      },
      'owner'
    )

    const { reply } = await invokeRegisteredRoute(registered, {
      authContext: undefined,
      ip: '127.0.0.1',
      headers: {},
    })

    expect(handler).toHaveBeenCalledOnce()
    expect(auditWriter).toHaveBeenCalledWith(
      expect.objectContaining({ tx, auth: expect.objectContaining({ userId: 'user-1' }) })
    )
    expect(reply.statusCode).toBe(503)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'audit_write_failed',
      message: 'Audit logging is unavailable',
    })
  })

  it('fails instead of preserving a pre-sent success when audit writing fails', async () => {
    const { transaction } = transactionHarness()
    const { registered } = mountProtectedRoute(
      {
        method: 'POST',
        url: '/api/v1/test/pre-sent-audit-failure',
        db: { transaction },
        auditWriter: async () => {
          throw new Error('audit unavailable')
        },
        security: {
          writeAuditEvent: { eventType: 'test.pre_sent_audit_failure' },
        },
        handler: async (_ctx, _req, reply) => {
          reply.send({ data: { changed: true } })
          return reply
        },
      },
      'owner'
    )
    const req = { authContext: undefined, ip: '127.0.0.1', headers: {} }
    const reply = replyMock()

    for (const preHandler of registered.preHandler) await preHandler(req, reply)

    await expect(registered.handler(req, reply)).rejects.toThrow(
      'SecureRoute: audited handlers must return data instead of sending replies'
    )
    expect(reply.send).not.toHaveBeenCalled()
  })
})
