import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { CapabilityId } from '@project-vault/shared'
import type { CapabilityGate } from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'
import {
  buildSecurePreHandlers,
  secureRoute,
  secureRoutes,
  SameTransactionAuditWriteError,
  type SecureRouteContext,
  type SecureRouteOptions,
  type SecureRouteRegistrationOptions,
} from './secure-route.js'
import { __resetCapabilityGateForTests, wireExtensionCapabilityGate } from './capability-gate.js'

const recordAuditQuotaRefusalBestEffort = vi.fn(async (_orgId: string) => undefined)
vi.mock('../modules/audit/quota-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/audit/quota-gate.js')>()
  return {
    ...actual,
    recordAuditQuotaRefusalBestEffort: (orgId: string) => recordAuditQuotaRefusalBestEffort(orgId),
  }
})

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

  it('provides a safe no-op post-commit registrar for authenticated non-org routes', async () => {
    const handler = vi.fn(async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      secureCtx.onPostCommit(() => undefined)
      return { data: { ok: true } }
    })
    const { registered } = mountProtectedRoute(
      {
        method: 'POST',
        url: '/api/v1/test/non-org-post-commit',
        security: { requireOrgScope: false, writeAuditEvent: false },
        handler,
      },
      'owner'
    )

    const reply = replyMock()
    await invokeRegisteredRoute(registered, { authContext: undefined }, reply)

    expect(reply.send).toHaveBeenCalledWith({ data: { ok: true } })
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
    // enforceUserRateLimit (route-helpers.ts) bypasses enforcement under NODE_ENV=test by
    // default — opt back in here to cover real 429 behavior.
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    try {
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
    } finally {
      delete process.env['RATE_LIMIT_TEST_BYPASS']
    }
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

  it('sends a 503 audit_quota_exhausted response and records the refusal when the audit gate refuses the write for quota', async () => {
    recordAuditQuotaRefusalBestEffort.mockClear()
    const { tx, transaction } = transactionHarness()
    const auditWriter = vi.fn(async () => {
      throw new SameTransactionAuditWriteError('quota exhausted', 'audit_quota_exhausted')
    })
    const handler = vi.fn(async () => ({ data: { changed: true } }))
    const { registered } = mountProtectedRoute(
      {
        method: 'POST',
        url: '/api/v1/test/audit-quota-exhausted',
        db: { transaction },
        auditWriter,
        security: {
          writeAuditEvent: { eventType: 'test.audit_quota_exhausted', resourceType: 'test' },
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
      code: 'audit_quota_exhausted',
      message: 'Audit storage quota exhausted for this organization',
    })
    expect(recordAuditQuotaRefusalBestEffort).toHaveBeenCalledWith(TEST_ORG_ID)
  })

  it('sends a 503 audit_gate_unavailable response when the audit quota gate statement itself errors', async () => {
    recordAuditQuotaRefusalBestEffort.mockClear()
    const { tx, transaction } = transactionHarness()
    const auditWriter = vi.fn(async () => {
      throw new SameTransactionAuditWriteError('gate down', 'audit_gate_unavailable')
    })
    const handler = vi.fn(async () => ({ data: { changed: true } }))
    const { registered } = mountProtectedRoute(
      {
        method: 'POST',
        url: '/api/v1/test/audit-gate-unavailable',
        db: { transaction },
        auditWriter,
        security: {
          writeAuditEvent: { eventType: 'test.audit_gate_unavailable', resourceType: 'test' },
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
      code: 'audit_gate_unavailable',
      message: 'Audit quota gate is unavailable',
    })
    expect(recordAuditQuotaRefusalBestEffort).not.toHaveBeenCalled()
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

  it('runs post-commit callbacks after commit and in registration order', async () => {
    const events: string[] = []
    const tx = { execute: vi.fn() }
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(tx)
      events.push('commit')
      return result
    })
    const { registered } = mountProtectedRoute({
      method: 'POST',
      url: '/api/v1/test/post-commit-order',
      db: { transaction },
      security: { writeAuditEvent: false },
      handler: async (ctx) => {
        const secureCtx = ctx as SecureRouteContext
        events.push('handler')
        secureCtx.onPostCommit(async () => {
          events.push('first callback')
        })
        secureCtx.onPostCommit(() => {
          events.push('second callback')
        })
        return { data: { ok: true } }
      },
    })

    await invokeRegisteredRoute(registered, { authContext: undefined })

    expect(events).toEqual(['handler', 'commit', 'first callback', 'second callback'])
  })

  it('does not run post-commit callbacks when the transaction rolls back', async () => {
    const events: string[] = []
    const tx = { execute: vi.fn() }
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        return await fn(tx)
      } catch (error) {
        events.push('rollback')
        throw error
      }
    })
    const { registered } = mountProtectedRoute({
      method: 'POST',
      url: '/api/v1/test/post-commit-rollback',
      db: { transaction },
      security: { writeAuditEvent: false },
      handler: async (ctx) => {
        const secureCtx = ctx as SecureRouteContext
        events.push('handler')
        secureCtx.onPostCommit(() => {
          events.push('callback')
        })
        throw new Error('transaction failed')
      },
    })

    await expect(invokeRegisteredRoute(registered, { authContext: undefined })).rejects.toThrow(
      'transaction failed'
    )

    expect(events).toEqual(['handler', 'rollback'])
  })

  it('isolates post-commit callback failures and still completes the request', async () => {
    const events: string[] = []
    const warn = vi.fn(() => {
      throw new Error('logger unavailable')
    })
    const { tx, transaction } = transactionHarness()
    const { registered } = mountProtectedRoute({
      method: 'POST',
      url: '/api/v1/test/post-commit-failure',
      db: { transaction },
      security: { writeAuditEvent: false },
      handler: async (ctx) => {
        const secureCtx = ctx as SecureRouteContext
        secureCtx.onPostCommit(() => {
          throw new Error('dispatch unavailable')
        })
        secureCtx.onPostCommit(() => {
          events.push('later callback')
        })
        return { data: { ok: true } }
      },
    })

    const { reply } = await invokeRegisteredRoute(
      registered,
      { authContext: undefined, log: { warn } },
      replyMock()
    )

    expect(reply.statusCode).toBe(200)
    expect(reply.send).toHaveBeenCalledWith({ data: { ok: true } })
    expect(events).toEqual(['later callback'])
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'secure_route.post_commit_callback_failed',
        err: expect.any(Error),
      }),
      expect.any(String)
    )
    expect(tx.execute).toHaveBeenCalled()
  })
})

describe('secureRoute — declarative capability gating (Story 23.3 AC-5, AC-10, AC-20, AC-22)', () => {
  afterEach(() => {
    __resetCapabilityGateForTests()
  })

  function loadedGateState(onCheckCapability: CapabilityGate['onCheckCapability']): ExtensionState {
    return {
      status: 'loaded' as const,
      manifest: { name: 'com.example.ext', apiVersion: '1.2.0', capabilities: [] },
      loadedAt: new Date().toISOString(),
      hooks: { capabilityGate: { onCheckCapability } },
    }
  }

  it('registration throws for an unknown capability id (AC-22 boot-time validation)', () => {
    expect(() =>
      secureRoute(
        fastifyStub(vi.fn(), async () => undefined),
        {
          method: 'GET',
          url: '/api/v1/test/unknown-capability',
          security: { capability: 'not_a_real_id' as never, requireOrgScope: false },
          handler: async () => ({}),
        }
      )
    ).toThrow('SecureRoute: unknown capability id')
  })

  it('with no capability annotation, the gate helper is never called even when a gate IS registered (AC-20 spy)', async () => {
    const onCheckCapability = vi.fn(async () => ({ permitted: false, reasonCode: 'x' }))
    wireExtensionCapabilityGate(loadedGateState(onCheckCapability))
    const { registered } = mountProtectedRoute({
      method: 'GET',
      url: '/api/v1/test/ungated',
      security: { requireOrgScope: false, writeAuditEvent: false },
      handler: async () => ({ ok: true }),
    })

    const { reply } = await invokeRegisteredRoute(registered)

    expect(reply.statusCode).toBe(200)
    expect(onCheckCapability).not.toHaveBeenCalled()
  })

  it('with no gate registered, an annotated route proceeds ungated (AC-5 fail-open)', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    const { registered } = mountProtectedRoute({
      method: 'GET',
      url: '/api/v1/test/gated-no-gate',
      security: {
        capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        requireOrgScope: false,
        writeAuditEvent: false,
      },
      handler,
    })

    const { reply } = await invokeRegisteredRoute(registered)

    expect(reply.statusCode).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

  it('a registered gate denying the capability yields 403 capability_denied and the handler never runs', async () => {
    wireExtensionCapabilityGate(
      loadedGateState(async () => ({
        permitted: false,
        reasonCode: 'not_entitled',
        message: 'Upgrade to enable this.',
      }))
    )
    const handler = vi.fn()
    const { registered } = mountProtectedRoute({
      method: 'POST',
      url: '/api/v1/test/gated-denied',
      security: {
        capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        requireOrgScope: false,
        writeAuditEvent: false,
      },
      handler,
    })

    const { reply } = await invokeRegisteredRoute(registered)

    expect(reply.statusCode).toBe(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'capability_denied',
      capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
      reasonCode: 'not_entitled',
      message: 'Upgrade to enable this.',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('a registered gate permitting the capability lets the handler run', async () => {
    wireExtensionCapabilityGate(loadedGateState(async () => ({ permitted: true })))
    const handler = vi.fn(async () => ({ ok: true }))
    const { registered } = mountProtectedRoute({
      method: 'POST',
      url: '/api/v1/test/gated-permitted',
      security: {
        capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        requireOrgScope: false,
        writeAuditEvent: false,
      },
      handler,
    })

    const { reply } = await invokeRegisteredRoute(registered)

    expect(reply.statusCode).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

  it('a below-minimumRole caller is rejected before the gate is ever consulted', async () => {
    const onCheckCapability = vi.fn(async (): Promise<{ permitted: true }> => ({ permitted: true }))
    wireExtensionCapabilityGate(loadedGateState(onCheckCapability))
    const { registered } = mountProtectedRoute(
      {
        method: 'POST',
        url: '/api/v1/test/gated-role-first',
        security: {
          capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
          minimumRole: 'admin',
          requireOrgScope: false,
          writeAuditEvent: false,
        },
        handler: async () => ({ ok: true }),
      },
      'member'
    )

    const { reply } = await invokeRegisteredRoute(registered)

    expect(reply.statusCode).toBe(403)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'insufficient_role',
      message: 'Insufficient permissions',
    })
    expect(onCheckCapability).not.toHaveBeenCalled()
  })

  it('AC-20: a permitted:true gate grants NOTHING for an unauthenticated caller — still 401, gate never consulted', async () => {
    const onCheckCapability = vi.fn(async (): Promise<{ permitted: true }> => ({ permitted: true }))
    wireExtensionCapabilityGate(loadedGateState(onCheckCapability))
    const route = vi.fn()
    // A registered `authenticate` preHandler that never sets req.authContext — simulates a
    // caller presenting no valid token, matching real Fastify authenticate-plugin behavior.
    secureRoute(
      fastifyStub(route, async () => undefined),
      {
        method: 'POST',
        url: '/api/v1/test/gated-unauthenticated',
        security: {
          capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
          requireOrgScope: false,
          writeAuditEvent: false,
        },
        handler: async () => ({ ok: true }),
      }
    )
    const registered = registeredRoute(route)

    const { reply } = await invokeRegisteredRoute(registered, { authContext: undefined })

    expect(reply.statusCode).toBe(401)
    expect(reply.send).toHaveBeenCalledWith({
      code: 'access_token_missing',
      message: 'Access token is missing',
    })
    expect(onCheckCapability).not.toHaveBeenCalled()
  })
})
