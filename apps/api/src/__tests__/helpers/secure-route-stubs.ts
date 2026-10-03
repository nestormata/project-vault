import { vi } from 'vitest'
import type { ExtensionState } from '../../extensions/loader.js'
import { buildApiRouteTable, type ApiRouteTable } from '../../lib/secure-route-overrides.js'
import type { SecureRouteRegistration } from '../../lib/secure-route.js'

/**
 * Story 68.8 — a minimal stand-in for the Fastify instance `secureRoute()` registers on, with the
 * pieces the M7 override path reads: the encapsulation `prefix`, the per-app override table and
 * the per-app registration collector. Captures every `route()` call.
 */
export type StubRoute = {
  method: string
  url: string
  config?: { pvRoute?: Record<string, unknown> }
  exposeHeadRoute?: boolean
  schema?: unknown
  attachValidation?: boolean
  onRequest?: unknown
  preHandler: Array<(req: unknown, reply: unknown) => unknown>
  onSend?: unknown
  handler: (req: unknown, reply: unknown) => Promise<unknown>
}

export type StubInstance = {
  prefix: string
  authenticate?: (req: { authContext?: unknown }) => Promise<void>
  pvApiRouteOverrides?: ApiRouteTable
  pvSecureRouteRegistry?: Map<string, SecureRouteRegistration>
  routes: StubRoute[]
  route: (options: StubRoute) => void
}

export const STUB_ORG_ID = ['00000000', '0000', '4000', '8000', '0000000000aa'].join('-')

export function stubAuthContext(orgRole = 'member'): Record<string, unknown> {
  return {
    userId: 'stub-user',
    orgId: STUB_ORG_ID,
    sessionId: 'stub-session',
    jti: 'stub-jti',
    sessionVersion: 1,
    orgRole,
    isPlatformOperator: false,
  }
}

export function stubInstance(
  options: {
    prefix?: string
    orgRole?: string | null
    table?: ApiRouteTable
    registry?: Map<string, SecureRouteRegistration>
  } = {}
): StubInstance {
  const routes: StubRoute[] = []
  const orgRole = options.orgRole === undefined ? 'member' : options.orgRole
  return {
    prefix: options.prefix ?? '',
    ...(orgRole === null
      ? {}
      : {
          authenticate: vi.fn((req: { authContext?: unknown }) => {
            req.authContext = stubAuthContext(orgRole)
            return Promise.resolve()
          }),
        }),
    ...(options.table ? { pvApiRouteOverrides: options.table } : {}),
    ...(options.registry ? { pvSecureRouteRegistry: options.registry } : {}),
    routes,
    route: (route) => {
      routes.push(route)
    },
  }
}

export type StubReply = {
  sent: boolean
  statusCode: number
  headers: Map<string, unknown>
  body: unknown
  status: (code: number) => StubReply
  code: (code: number) => StubReply
  header: (name: string, value: unknown) => StubReply
  send: (body?: unknown) => StubReply
}

export function stubReply(): StubReply {
  const reply: StubReply = {
    sent: false,
    statusCode: 200,
    headers: new Map(),
    body: undefined,
    status: (code) => {
      reply.statusCode = code
      return reply
    },
    code: (code) => reply.status(code),
    header: (name, value) => {
      reply.headers.set(name, value)
      return reply
    },
    send: (body) => {
      reply.sent = true
      reply.body = body
      return reply
    },
  }
  return reply
}

/** Runs a captured route's preHandlers then its handler, the way Fastify would. */
export async function runStubRoute(
  route: StubRoute,
  request: Record<string, unknown> = {}
): Promise<{ reply: StubReply; result: unknown; request: Record<string, unknown> }> {
  const reply = stubReply()
  const req = { ip: '203.0.113.9', headers: {}, params: {}, query: {}, ...request }
  for (const preHandler of route.preHandler) {
    await preHandler(req, reply)
    if (reply.sent) return { reply, result: reply, request: req }
  }
  const result = await route.handler(req, reply)
  return { reply, result, request: req }
}

/** A transaction stub that runs the callback with a fake `tx` whose `execute` is a spy. */
export function stubDb(): {
  transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>
  tx: { execute: ReturnType<typeof vi.fn> }
} {
  const tx = { execute: vi.fn(() => Promise.resolve(undefined)) }
  return { tx, transaction: (fn) => fn(tx) }
}

export function loadedApiRoutesState(
  apiRoutes: unknown,
  routes: Record<string, unknown>,
  extraHooks: Record<string, unknown> = {}
): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.acme.api-routes', apiVersion: '3.27.0', capabilities: [], apiRoutes },
    hooks: { apiRoutes: { routes }, ...extraHooks },
    loadedAt: new Date().toISOString(),
  } as unknown as ExtensionState
}

export function tableFor(apiRoutes: unknown, routes: Record<string, unknown>): ApiRouteTable {
  const table = buildApiRouteTable(loadedApiRoutesState(apiRoutes, routes))
  if (!table) throw new Error('expected an apiRoutes table')
  return table
}
