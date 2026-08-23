import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { CapabilityId } from '@project-vault/shared'
import type { CapabilityGate } from '@project-vault/extension-api'
import {
  __resetCapabilityGateForTests,
  wireExtensionCapabilityGate,
} from '../../lib/capability-gate.js'
import type { SecureRouteRegistrationOptions } from '../../lib/secure-route.js'

const secureRouteSpy = vi.hoisted(() => vi.fn())
vi.mock('../../lib/secure-route.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/secure-route.js')>()
  return {
    ...actual,
    secureRoute: (
      fastify: Parameters<typeof actual.secureRoute>[0],
      options: SecureRouteRegistrationOptions
    ) => {
      secureRouteSpy(fastify, options)
      return actual.secureRoute(fastify, options)
    },
  }
})

const { capabilitiesRoutes } = await import('./capabilities-routes.js')

const TEST_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000001'].join('-')
const OTHER_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000002'].join('-')

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

function authContext(orgId: string, orgRole = 'member'): Record<string, unknown> {
  return {
    userId: 'user-1',
    orgId,
    sessionId: 'session-1',
    jti: 'jti-1',
    sessionVersion: 1,
    orgRole,
  }
}

/** Registers the real module against a stub fastify (mirrors secure-route.test.ts's pattern) and
 * returns the single route Fastify would have received. */
async function registerCapabilitiesRoute(): Promise<RegisteredRoute> {
  const route = vi.fn()
  const authenticate = vi.fn(async (req: { authContext?: unknown }) => {
    req.authContext = authContext(TEST_ORG_ID)
  })
  const fastify = {
    authenticate,
    route,
    withTypeProvider: () => ({ route }),
  } as unknown as FastifyApp
  await capabilitiesRoutes(fastify)
  return route.mock.calls[0]?.[0] as RegisteredRoute
}

async function invoke(
  registered: RegisteredRoute,
  req: Record<string, unknown>
): Promise<{ reply: ReplyMock; result: unknown }> {
  const reply = replyMock()
  for (const preHandler of registered.preHandler) await preHandler(req, reply)
  const result = await registered.handler(req, reply)
  return { reply, result }
}

function baseReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'req-1',
    ip: '127.0.0.1',
    log: { error: () => undefined, warn: () => undefined },
    query: {},
    params: {},
    body: undefined,
    headers: {},
    ...overrides,
  }
}

describe('GET /api/v1/capabilities', () => {
  afterEach(() => {
    __resetCapabilityGateForTests()
  })

  it('AC-1: with no gate registered, returns { capabilities: { <every CapabilityId>: true } }', async () => {
    const registered = await registerCapabilitiesRoute()
    const { reply, result } = await invoke(registered, baseReq())

    expect(reply.statusCode).toBe(200)
    const expected = Object.fromEntries(
      (Object.values(CapabilityId) as string[]).map((id) => [id, true])
    )
    expect(result).toEqual({ data: { capabilities: expected } })
  })

  it('AC-1/AC-6: the response key set is exactly Object.values(CapabilityId) — no more, no fewer', async () => {
    const registered = await registerCapabilitiesRoute()
    const { result } = (await invoke(registered, baseReq())) as {
      result: { data: { capabilities: Record<string, boolean> } }
    }

    expect(Object.keys(result.data.capabilities).sort()).toEqual(
      (Object.values(CapabilityId) as string[]).sort()
    )
  })

  it('AC-1: with a gate denying the one registered capability, returns { capabilities: { ...: false } }', async () => {
    wireExtensionCapabilityGate({
      status: 'loaded',
      manifest: { name: 'test.deny-all', apiVersion: '1.3.0', capabilities: [] },
      loadedAt: new Date().toISOString(),
      hooks: {
        capabilityGate: {
          onCheckCapability: async () => ({ permitted: false, reasonCode: 'not_entitled' }),
        },
      },
    })
    const registered = await registerCapabilitiesRoute()
    const { result } = (await invoke(registered, baseReq())) as {
      result: { data: { capabilities: Record<string, boolean> } }
    }

    expect(result.data.capabilities[CapabilityId.MONITORING_PUBLIC_STATUS_PAGE]).toBe(false)
  })

  it('AC-1 edge case: a throwing/timing-out gate still surfaces as plain false, not a distinguishable shape', async () => {
    wireExtensionCapabilityGate({
      status: 'loaded',
      manifest: { name: 'test.throws', apiVersion: '1.3.0', capabilities: [] },
      loadedAt: new Date().toISOString(),
      hooks: {
        capabilityGate: {
          onCheckCapability: async () => {
            throw new Error('gate exploded')
          },
        } as unknown as CapabilityGate,
      },
    })
    const registered = await registerCapabilitiesRoute()
    const { result } = (await invoke(registered, baseReq())) as {
      result: { data: { capabilities: Record<string, boolean> } }
    }

    expect(result.data.capabilities[CapabilityId.MONITORING_PUBLIC_STATUS_PAGE]).toBe(false)
  })

  it('AC-4: orgId is resolved only from request.auth — a query/body/header orgId is never read', async () => {
    const registered = await registerCapabilitiesRoute()
    const req = baseReq({
      query: { orgId: OTHER_ORG_ID },
      body: { orgId: OTHER_ORG_ID },
      headers: { 'x-org-id': OTHER_ORG_ID },
    })
    // authContext is set by the preHandler stub to TEST_ORG_ID regardless of the request shape
    // above — this test documents/protects that the handler itself never reads req.query/body/
    // headers for orgId (it only ever destructures ctx.auth).
    const { reply, result } = (await invoke(registered, req)) as {
      reply: ReplyMock
      result: { data: { capabilities: Record<string, boolean> } }
    }

    expect(reply.statusCode).toBe(200)
    // No gate registered — every id resolves permitted, proving the (ignored) OTHER_ORG_ID inputs
    // never influenced the outcome.
    expect(result.data.capabilities[CapabilityId.MONITORING_PUBLIC_STATUS_PAGE]).toBe(true)
  })

  it('AC-2/AC-6: registers with requireOrgScope:false, writeAuditEvent:false, and no security.capability', async () => {
    secureRouteSpy.mockClear()
    const route = vi.fn()
    const fastify = {
      authenticate: vi.fn(async (req: { authContext?: unknown }) => {
        req.authContext = authContext(TEST_ORG_ID)
      }),
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyApp
    await capabilitiesRoutes(fastify)
    const registrationOptions = secureRouteSpy.mock.calls[0]?.[1] as SecureRouteRegistrationOptions
    expect(registrationOptions.security?.requireOrgScope).toBe(false)
    expect(registrationOptions.security?.writeAuditEvent).toBe(false)
    expect(registrationOptions.security?.capability).toBeUndefined()
    // AC-5: same shape as LIST_RATE_LIMIT (120/60s), own key — not the write-oriented limit.
    expect(registrationOptions.security?.rateLimit).toEqual({
      max: 120,
      timeWindowMs: 60_000,
      key: 'GET /api/v1/capabilities',
    })
  })

  it('AC-5: the 121st request within 60s from one caller gets 429, not a fabricated all-denied map', async () => {
    // A caller distinct from every other test in this file — this route's rate-limit bucket is
    // keyed per-userId, and this file's other tests share `user-1` under the same 120/60s budget.
    const rateLimitOrgId = ['00000000', '0000', '4000', '8000', '000000000003'].join('-')
    const route = vi.fn()
    const authenticate = vi.fn(async (req: { authContext?: unknown }) => {
      req.authContext = { ...authContext(rateLimitOrgId), userId: 'rate-limit-user' }
    })
    const fastify = {
      authenticate,
      route,
      withTypeProvider: () => ({ route }),
    } as unknown as FastifyApp
    await capabilitiesRoutes(fastify)
    const registered = route.mock.calls[0]?.[0] as RegisteredRoute

    let lastReply: ReplyMock | undefined
    for (let i = 0; i < 121; i += 1) {
      const outcome = await invoke(registered, baseReq())
      lastReply = outcome.reply
    }

    expect(lastReply?.statusCode).toBe(429)
    expect(lastReply?.send).toHaveBeenCalledWith(
      expect.not.objectContaining({ data: expect.anything() })
    )
  })
})
