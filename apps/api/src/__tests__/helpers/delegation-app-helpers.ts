import Fastify, { type FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { vi } from 'vitest'
import { signDelegationAssertion, type AssertionOptions } from './delegation-test-helpers.js'

/**
 * Story 71.9 — a real `secureRoute` delegated app for the observability suites. The caller MUST
 * set `VAULT_DELEGATION_VERIFY_KEYS` and `VAULT_HANDOFF_INSTANCE_ID` before the first call: the
 * modules imported here read env at load. Nothing is mocked: the real `authenticate` plugin, the
 * real API-route install path and the real delegation stages.
 */

export const DELEGATED_URL = '/cm/audit-events'
export const DELEGATED_ACTOR = 'user_actor_subject_01'
export const JSON_HEADERS = { 'content-type': 'application/json' }

export type DelegatedRouteSpec = {
  url: string
  method?: string
  security?: Record<string, unknown>
  schema?: unknown
}

export type DelegatedBootOptions = {
  routes?: DelegatedRouteSpec[]
  logStream?: NodeJS.WritableStream
  /** Registers extra (non-delegated) routes on the same app before it is ready. */
  extraRoutes?: (app: FastifyInstance) => void
  /** Fastify `trustProxy` setting (default off). */
  trustProxy?: boolean
}

const opened: FastifyInstance[] = []

export async function closeDelegatedApps(): Promise<void> {
  await Promise.all(opened.splice(0).map((app) => app.close()))
}

export async function bootDelegatedApp(options: DelegatedBootOptions = {}) {
  const { default: authenticatePlugin } = await import('../../plugins/authenticate.js')
  const { installApiRoutes, registerApiRouteAdds } =
    await import('../../extensions/api-routes/install.js')
  const { loadedApiRoutesState } = await import('./secure-route-stubs.js')
  const routes = options.routes ?? [{ url: DELEGATED_URL }]
  const seen: Array<Record<string, unknown>> = []
  const handler = async (ctx: Record<string, unknown>) => {
    seen.push(ctx)
    return { ok: true }
  }
  const app = Fastify({
    logger: options.logStream ? { level: 'debug', stream: options.logStream } : false,
    routerOptions: { ignoreTrailingSlash: true },
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(authenticatePlugin)
  const keyOf = (route: DelegatedRouteSpec) => `${route.method ?? 'POST'} ${route.url}`
  const runtime = installApiRoutes(
    app as never,
    loadedApiRoutesState(
      {
        add: routes.map((route) => ({
          method: route.method ?? 'POST',
          url: route.url,
          options: {
            security: { delegation: true, writeAuditEvent: false, ...route.security },
            ...(route.schema ? { schema: true } : {}),
          },
        })),
      },
      Object.fromEntries(
        routes.map((route) => [
          keyOf(route),
          { handler, ...(route.schema ? { schema: route.schema } : {}) },
        ])
      )
    )
  )
  await app.after()
  await registerApiRouteAdds(app as never, runtime, {
    logger: { info: vi.fn(), warn: vi.fn() } as never,
    docsEnabled: true,
  })
  options.extraRoutes?.(app)
  await app.ready()
  opened.push(app)
  return { app, seen }
}

export type DelegatedCall = {
  url?: string
  org: string
  sub?: string
  op?: string
  /** An object is JSON-encoded; a string is sent verbatim. Omit for a bodyless request. */
  body?: unknown
  assertion?: AssertionOptions
  headers?: Record<string, string>
  /** Overrides the whole Authorization header value (`null` sends none). */
  authorization?: string | null
  /** A fixed token (to present the same assertion twice). */
  token?: string
  remoteAddress?: string
}

function rawBodyOf(body: unknown): string | undefined {
  if (body === undefined) return undefined
  return typeof body === 'string' ? body : JSON.stringify(body)
}

function authorizationFor(call: DelegatedCall, raw: string | undefined): string | undefined {
  if (call.authorization === null) return undefined
  if (call.authorization !== undefined) return call.authorization
  const token =
    call.token ??
    signDelegationAssertion(
      {
        org: call.org,
        sub: call.sub ?? DELEGATED_ACTOR,
        op: call.op ?? `POST ${call.url ?? DELEGATED_URL}`,
        body: raw ?? '',
      },
      call.assertion
    )
  return `PV-Delegation ${token}`
}

export async function callDelegated(app: FastifyInstance, call: DelegatedCall) {
  const raw = rawBodyOf(call.body)
  const authorization = authorizationFor(call, raw)
  return app.inject({
    method: 'POST',
    url: call.url ?? DELEGATED_URL,
    ...(call.remoteAddress ? { remoteAddress: call.remoteAddress } : {}),
    ...(raw === undefined ? {} : { payload: raw }),
    headers: {
      ...(raw === undefined ? {} : JSON_HEADERS),
      ...(authorization === undefined ? {} : { authorization }),
      ...call.headers,
    },
  })
}
