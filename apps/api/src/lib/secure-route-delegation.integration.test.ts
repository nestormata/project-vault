import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getDb } from '@project-vault/db'
import { platformSecurityEvents, sessions } from '@project-vault/db/schema'
import { register } from 'prom-client'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import {
  bodyHashOf,
  countBurnedAssertions,
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  DELEGATION_TEST_KID,
  delegationTestVerifyKeysJson,
  linkDelegationActor,
  signDelegationAssertion,
  type AssertionOptions,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from '../__tests__/helpers/capture-logs.js'

process.env['VAULT_DELEGATION_VERIFY_KEYS'] = delegationTestVerifyKeysJson()
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()

// Loaded only after the env above: this helper's import chain reads env at module load.
const { loadedApiRoutesState } = await import('../__tests__/helpers/secure-route-stubs.js')

// Loaded only now: env is read when these modules load.
const { secureRoute } = await import('./secure-route.js')
const { default: authenticatePlugin } = await import('../plugins/authenticate.js')
const { installApiRoutes, registerApiRouteAdds } =
  await import('../extensions/api-routes/install.js')
const replayStore = await import('../modules/auth/delegation-replay-store.js')
const orgService = await import('../modules/service-provisioning/service.js')
const actorModule = await import('../modules/auth/delegation-actor.js')
const sessionActivity = await import('../modules/auth/session-activity.js')
const stages = await import('./delegation-stages.js')
const { getRequestContext, bindRequestContextLifecycle } = await import('./request-context.js')
const { enforceUserRateLimit } = await import('./route-helpers.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

const URL_PATH = '/cm/audit-events'
const KEY = `POST ${URL_PATH}`
const ACTOR_SUB = 'user_actor_subject_01'
const JSON_HEADERS = { 'content-type': 'application/json' }
const NIL_UUID = ['00000000', '0000', '0000', '0000', '000000000000'].join('-')
const SENTINEL_SUBJECT = 'sentinel-actor-subject'
const CM_ON_REQUEST = 'cm-on-request'
const RAW_URL = '/raw/cm-fixture'

type Seen = { ctx: Record<string, unknown>; body: unknown; orgSetting: unknown }

type RouteSecurity = Record<string, unknown>

type BootOptions = {
  security?: RouteSecurity
  url?: string
  method?: string
  bodyLimit?: number
  schema?: unknown
  handler?: (ctx: Record<string, unknown>, req: FastifyRequest) => unknown
  logStream?: NodeJS.WritableStream
  before?: (app: FastifyInstance) => Promise<void> | void
  pv?: (app: FastifyInstance) => void
  extraDeclaration?: Record<string, unknown>
  extraRoutes?: Record<string, unknown>
}

const opened: FastifyInstance[] = []

function recordingHandler(seen: Seen[]) {
  return async (ctx: Record<string, unknown>, req: FastifyRequest) => {
    const tx = ctx['tx'] as { execute: (query: unknown) => Promise<unknown> } | undefined
    const rows = tx
      ? await tx.execute(sql`select current_setting('app.current_org_id', true) as org`)
      : undefined
    const orgSetting = rows ? (Array.from(rows as never)[0] as { org?: string })?.org : undefined
    seen.push({ ctx, body: req.body, orgSetting })
    return { ok: true }
  }
}

/** Runs `fn` over `items` one after another (no parallelism, no await inside a loop). */
async function inSequence<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous
    results.push(await fn(item))
  }, Promise.resolve())
  return results
}

function extensionState(options: BootOptions, handler: unknown) {
  const url = options.url ?? URL_PATH
  const method = options.method ?? 'POST'
  const routeOptions = {
    security: options.security ?? { delegation: true, writeAuditEvent: false },
    ...(options.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    ...(options.schema ? { schema: true } : {}),
  }
  return loadedApiRoutesState(
    { add: [{ method, url, options: routeOptions }], ...options.extraDeclaration },
    {
      [`${method} ${url}`]: { handler, ...(options.schema ? { schema: options.schema } : {}) },
      ...options.extraRoutes,
    }
  )
}

async function boot(options: BootOptions = {}) {
  const seen: Seen[] = []
  const app = Fastify({
    logger: options.logStream ? { level: 'debug', stream: options.logStream } : false,
    routerOptions: { ignoreTrailingSlash: true },
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(authenticatePlugin)
  await options.before?.(app)
  const runtime = installApiRoutes(
    app as never,
    extensionState(options, options.handler ?? recordingHandler(seen))
  )
  options.pv?.(app)
  await app.after()
  await registerApiRouteAdds(app as never, runtime, {
    logger: { info: vi.fn(), warn: vi.fn() } as never,
    docsEnabled: true,
  })
  await app.ready()
  opened.push(app)
  return { app, seen, runtime }
}

type CallOptions = {
  url?: string
  method?: string
  org: string
  sub?: string
  op?: string
  /** An object is JSON-encoded; a string is sent verbatim. Omit for a bodyless request. */
  body?: unknown
  assertion?: AssertionOptions
  headers?: Record<string, string>
  /** Overrides the whole Authorization header value. */
  authorization?: string | null
  /** A fixed token (to replay the same assertion). */
  token?: string
}

function rawBodyOf(body: unknown): string | undefined {
  if (body === undefined) return undefined
  return typeof body === 'string' ? body : JSON.stringify(body)
}

function authorizationFor(options: CallOptions, raw: string | undefined): string | undefined {
  if (options.authorization === null) return undefined
  if (options.authorization !== undefined) return options.authorization
  const method = options.method ?? 'POST'
  const token =
    options.token ??
    signDelegationAssertion(
      {
        org: options.org,
        sub: options.sub ?? ACTOR_SUB,
        op: options.op ?? `${method} ${options.url ?? URL_PATH}`,
        body: raw ?? '',
      },
      options.assertion
    )
  return `PV-Delegation ${token}`
}

async function call(app: FastifyInstance, options: CallOptions) {
  const raw = rawBodyOf(options.body)
  const authorization = authorizationFor(options, raw)
  return app.inject({
    method: (options.method ?? 'POST') as 'POST',
    url: options.url ?? URL_PATH,
    ...(raw === undefined ? {} : { payload: raw }),
    headers: {
      ...(raw === undefined ? {} : JSON_HEADERS),
      ...(authorization === undefined ? {} : { authorization }),
      ...options.headers,
    },
  })
}

function counterValue(outcome: string, kid?: string): number {
  const metric = register.getSingleMetric('pv_delegation_assertions_total') as unknown as {
    hashMap?: Record<string, { value: number; labels: Record<string, string> }>
  }
  const values = Object.values(metric?.hashMap ?? {})
  return values
    .filter((entry) => entry.labels['outcome'] === outcome)
    .filter((entry) => kid === undefined || entry.labels['kid'] === kid)
    .reduce((sum, entry) => sum + entry.value, 0)
}

async function securityEvents(reason: string, since: Date) {
  const rows = await getDb()
    .select()
    .from(platformSecurityEvents)
    .where(
      sql`event_type = 'delegation_assertion_rejected' and created_at >= ${since.toISOString()}::timestamptz`
    )
  return rows.filter((row) => (row.payload as { reason?: string }).reason === reason)
}

function genericRejection(res: { statusCode: number; body: string; headers: object }) {
  const headers = new Map(Object.entries(res.headers))
  return {
    status: res.statusCode,
    body: res.body,
    contentType: headers.get('content-type'),
    challenge: headers.get('www-authenticate'),
    length: headers.get('content-length'),
  }
}

let org: DelegationOrgFixture

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-stage-test-passphrase')
  org = await createDelegationOrg('main')
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(opened.map((app) => app.close()))
})

describe('Story 71.3 AC-2 — header parse, stateless verification and status table', () => {
  it('rejects every pre-signature failure with one identical generic 401 and never calls the handler', async () => {
    const { app, seen } = await boot()
    const good = signDelegationAssertion({ org: org.cmOrgId, sub: ACTOR_SUB, op: KEY })
    const parts = good.split('.')
    const responses = await Promise.all([
      call(app, { org: org.cmOrgId, authorization: null }),
      call(app, { org: org.cmOrgId, authorization: `Bearer ${good}` }),
      call(app, { org: org.cmOrgId, authorization: 'pv-delegation lowercase-scheme' }),
      call(app, { org: org.cmOrgId, authorization: 'PV-Delegation' }),
      call(app, { org: org.cmOrgId, authorization: 'PV-Delegation  two-spaces' }),
      call(app, { org: org.cmOrgId, authorization: `PV-Delegation ${'a'.repeat(9 * 1024)}` }),
      call(app, { org: org.cmOrgId, authorization: 'PV-Delegation not-a-jws' }),
      call(app, {
        org: org.cmOrgId,
        assertion: { header: { kid: 'some-unconfigured-kid' } },
      }),
      call(app, { org: org.cmOrgId, assertion: { header: { alg: 'none' } } }),
      call(app, { org: org.cmOrgId, assertion: { wrongKey: true } }),
      call(app, {
        org: org.cmOrgId,
        authorization: `PV-Delegation ${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]?.length ?? 86)}`,
      }),
    ])
    const shapes = responses.map(genericRejection)
    for (const shape of shapes) expect(shape).toEqual(shapes[0])
    expect(shapes[0]?.status).toBe(401)
    expect(JSON.parse(shapes[0]?.body ?? '{}')).toMatchObject({ code: 'delegation_invalid' })
    expect(seen).toHaveLength(0)
  })

  it('does not echo the assertion, an unknown kid or the actor subject in any rejection', async () => {
    const { app } = await boot()
    const unknownKid = 'secret-unknown-kid-value'
    const res = await call(app, {
      org: org.cmOrgId,
      sub: SENTINEL_SUBJECT,
      assertion: { header: { kid: unknownKid } },
    })
    expect(res.body).not.toContain(unknownKid)
    expect(res.body).not.toContain(SENTINEL_SUBJECT)
    const wrongOp = await call(app, {
      org: org.cmOrgId,
      sub: SENTINEL_SUBJECT,
      op: 'POST /something/else',
    })
    expect(wrongOp.statusCode).toBe(403)
    expect(wrongOp.body).not.toContain(SENTINEL_SUBJECT)
    expect(wrongOp.body).not.toContain(DELEGATION_TEST_KID)
  })

  it('rejects a plain session cookie and a Bearer token on a delegated route (no substitute, Q8)', async () => {
    const { app, seen } = await boot()
    const cookie = await app.inject({
      method: 'POST',
      url: URL_PATH,
      headers: { cookie: 'access-token=anything' },
    })
    expect(cookie.statusCode).toBe(401)
    expect(JSON.parse(cookie.body)).toMatchObject({ code: 'delegation_invalid' })
    const bearer = await app.inject({
      method: 'POST',
      url: URL_PATH,
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' },
    })
    expect(JSON.parse(bearer.body)).toMatchObject({ code: 'delegation_invalid' })
    expect(seen).toHaveLength(0)
  })

  const now = Math.floor(Date.now() / 1000)
  const typedRows: Array<{
    name: string
    assertion: AssertionOptions
    op?: string
    status: number
    code: string
    outcome: string
  }> = [
    {
      name: 'a missing claim',
      assertion: { omit: ['org'] },
      status: 401,
      code: 'delegation_invalid_claims',
      outcome: 'malformed_claim',
    },
    {
      name: 'a malformed claim (bad ver)',
      assertion: { claims: { ver: 2 } },
      status: 401,
      code: 'delegation_invalid_claims',
      outcome: 'malformed_claim',
    },
    {
      name: 'an expired assertion',
      assertion: { claims: { iat: now - 200, exp: now - 150 } },
      status: 401,
      code: 'delegation_expired',
      outcome: 'expired',
    },
    {
      name: 'an iat too far in the future',
      assertion: { claims: { iat: now + 300, exp: now + 330 } },
      status: 401,
      code: 'delegation_not_yet_valid',
      outcome: 'clock_skew',
    },
    {
      name: 'the wrong audience',
      assertion: { claims: { aud: 'pvd:another-instance' } },
      status: 421,
      code: 'delegation_wrong_instance',
      outcome: 'audience_mismatch',
    },
    {
      name: 'an op that is not this route',
      assertion: {},
      op: 'POST /cm/other-operation',
      status: 403,
      code: 'delegation_operation_mismatch',
      outcome: 'operation_mismatch',
    },
  ]
  it.each(typedRows)(
    '$name -> $status $code (counter outcome $outcome, security event written)',
    async ({ assertion, op, status, code, outcome }) => {
      const { app, seen } = await boot()
      const before = counterValue(outcome)
      const since = new Date()
      const res = await call(app, { org: org.cmOrgId, assertion, op })
      expect(res.statusCode).toBe(status)
      expect(JSON.parse(res.body)).toMatchObject({ code })
      expect(seen).toHaveLength(0)
      expect(counterValue(outcome)).toBe(before + 1)
      const events = await securityEvents(outcome, since)
      expect(events.length).toBeGreaterThanOrEqual(1)
    }
  )

  it('counts a post-signature delegation_malformed as malformed, never signature_invalid (DW-513 item 5)', async () => {
    const { app } = await boot()
    const beforeMalformed = counterValue('malformed')
    const beforeSignature = counterValue('signature_invalid')
    const res = await call(app, {
      org: org.cmOrgId,
      authorization: 'PV-Delegation only.two',
    })
    expect(res.statusCode).toBe(401)
    expect(counterValue('malformed')).toBe(beforeMalformed + 1)
    expect(counterValue('signature_invalid')).toBe(beforeSignature)
  })

  it('counts pre-signature rejections without writing a security event or touching the database', async () => {
    const { app } = await boot()
    const orgSpy = vi.spyOn(orgService, 'resolveOrgByCentralizemeId')
    const burnSpy = vi.spyOn(replayStore, 'burnDelegationAssertion')
    const actorSpy = vi.spyOn(actorModule, 'resolveDelegatedActor')
    const before = counterValue('signature_invalid')
    const jtiBefore = await countBurnedAssertions(org.orgId)
    const eventsBefore = await getDb().select().from(platformSecurityEvents)
    const res = await call(app, { org: org.cmOrgId, assertion: { wrongKey: true } })
    expect(res.statusCode).toBe(401)
    expect(counterValue('signature_invalid')).toBe(before + 1)
    expect(orgSpy).not.toHaveBeenCalled()
    expect(burnSpy).not.toHaveBeenCalled()
    expect(actorSpy).not.toHaveBeenCalled()
    expect(await countBurnedAssertions(org.orgId)).toBe(jtiBefore)
    expect(await getDb().select().from(platformSecurityEvents)).toHaveLength(eventsBefore.length)
  })
})

describe('Story 71.3 AC-1 — delegation is a host security field that installs the stages', () => {
  it('records delegation only on routes that declared it (registry tripwire)', async () => {
    const { runtime } = await boot({
      pv: (app) => {
        void app.register(async (instance) => {
          secureRoute(instance as never, {
            method: 'GET',
            url: '/plain',
            security: { requireAuth: false },
            handler: async () => ({}),
          })
        })
      },
    })
    const flagged = [...runtime.registry.values()].filter((entry) => entry.delegation)
    expect(flagged.map((entry) => entry.key)).toEqual([KEY])
    expect(runtime.registry.get('GET /plain')?.delegation).toBe(false)
  })

  it('fails the boot, naming the route, for delegation with requireMfa, requirePlatformOperator or requireAuth:false', async () => {
    const cases: Array<[RouteSecurity, RegExp]> = [
      [{ delegation: true, requireMfa: true, writeAuditEvent: false }, /requireMfa/],
      [
        { delegation: true, requirePlatformOperator: true, writeAuditEvent: false },
        /requirePlatform/,
      ],
      [{ delegation: true, requireAuth: false, writeAuditEvent: false }, /requireAuth/],
    ]
    for (const [security, pattern] of cases) {
      const stub = { prefix: '', route: vi.fn(), authenticate: vi.fn() }
      expect(() =>
        secureRoute(stub as never, {
          method: 'POST',
          url: '/cm/first-party',
          security: security as never,
          handler: async () => ({}),
        })
      ).toThrow(pattern)
      expect(stub.route).not.toHaveBeenCalled()
    }
  })

  it('fails the boot when a delegated mutating route leaves the default audit write on (R5)', async () => {
    const stub = { prefix: '', route: vi.fn() }
    expect(() =>
      secureRoute(stub as never, {
        method: 'POST',
        url: '/cm/default-audit',
        security: { delegation: true } as never,
        handler: async () => ({}),
      })
    ).toThrow(/POST \/cm\/default-audit.*writeAuditEvent/s)
    expect(() =>
      secureRoute(stub as never, {
        method: 'POST',
        url: '/cm/custom-audit',
        security: { delegation: true, writeAuditEvent: { eventType: 'cm.x' } } as never,
        handler: async () => ({}),
      })
    ).toThrow(/writeAuditEvent/)
    // A non-mutating delegated route has no default audit, and no authenticate is required.
    expect(() =>
      secureRoute(stub as never, {
        method: 'GET',
        url: '/cm/read',
        security: { delegation: true } as never,
        handler: async () => ({}),
      })
    ).not.toThrow()
    expect(stub.route).toHaveBeenCalledTimes(1)
  })

  it('installs preParsing and preHandler stages and no authenticate on a delegated route', async () => {
    const stub = { prefix: '', route: vi.fn(), authenticate: vi.fn() }
    secureRoute(stub as never, {
      method: 'POST',
      url: '/cm/inspect',
      security: { delegation: true, writeAuditEvent: false } as never,
      handler: async () => ({}),
    })
    const options = stub.route.mock.calls[0]?.[0] as Record<string, unknown>
    // S1 + S2 run in preParsing, after every onRequest hook. Story 71.9: the onRequest array holds
    // exactly the delegation's own per-IP limiter stage (nothing else on a bare delegated route).
    expect(options['onRequest']).toHaveLength(1)
    expect(options['preParsing']).toHaveLength(2)
    expect(options['preHandler']).not.toContain(stub.authenticate)
    expect((options['preHandler'] as unknown[]).length).toBeGreaterThan(0)
  })
})

describe('Story 71.3 AC-9/AC-1 — wrap, replace and replaceSecurity cannot skip the stages', () => {
  const PV_URL = '/api/v1/cm-fixture'
  const PV_KEY = `POST ${PV_URL}`

  async function bootOverride(
    mode: 'wrap' | 'replace',
    pvSecurity: RouteSecurity,
    replaceSecurity?: RouteSecurity,
    hooks?: { prepend?: string[]; append?: string[] }
  ) {
    const cmCalls = vi.fn()
    const pvCalls = vi.fn()
    const authenticate = vi.fn(async (req: FastifyRequest) => {
      req.authContext = undefined
    })
    const order: string[] = []
    const cmHandler = async (
      _ctx: unknown,
      _req: unknown,
      _reply: unknown,
      next?: () => unknown
    ) => {
      cmCalls()
      return mode === 'wrap' && next ? next() : { cm: true }
    }
    const state = loadedApiRoutesState(
      {
        override: [
          {
            method: 'POST',
            url: PV_URL,
            mode,
            ...(replaceSecurity === undefined
              ? {}
              : { replaceSecurity: true, security: replaceSecurity }),
            ...(hooks ? { hooks } : {}),
          },
        ],
      },
      {
        [PV_KEY]: {
          handler: cmHandler,
          hooks: {
            onRequest: async () => {
              order.push(CM_ON_REQUEST)
            },
            preHandler: async () => {
              order.push('cm-pre-handler')
            },
          },
        },
      }
    )
    const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    app.addHook('onRequest', bindRequestContextLifecycle)
    app.decorate('authenticate', authenticate)
    const runtime = installApiRoutes(app as never, state)
    void app.register(
      async (instance) => {
        secureRoute(instance as never, {
          method: 'POST',
          url: '',
          security: pvSecurity as never,
          handler: async () => {
            pvCalls()
            return { pv: true }
          },
        })
      },
      { prefix: PV_URL }
    )
    await app.after()
    await registerApiRouteAdds(app as never, runtime, {
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      docsEnabled: true,
    })
    await app.ready()
    opened.push(app)
    return { app, cmCalls, pvCalls, authenticate, order, runtime }
  }

  const delegatedPv = { delegation: true, writeAuditEvent: false, requireAuth: true }

  it.each(['wrap', 'replace'] as const)(
    '%s on a delegated route: 401, 401, 403 reach neither cm() nor next(); a valid assertion runs exactly once',
    async (mode) => {
      const { app, cmCalls, pvCalls, authenticate } = await bootOverride(mode, delegatedPv)
      const noHeader = await call(app, { url: PV_URL, org: org.cmOrgId, authorization: null })
      const badSignature = await call(app, {
        url: PV_URL,
        org: org.cmOrgId,
        assertion: { wrongKey: true },
      })
      const otherOp = await call(app, { url: PV_URL, org: org.cmOrgId, op: 'POST /elsewhere' })
      expect([noHeader.statusCode, badSignature.statusCode, otherOp.statusCode]).toEqual([
        401, 401, 403,
      ])
      expect(cmCalls).not.toHaveBeenCalled()
      expect(pvCalls).not.toHaveBeenCalled()
      const ok = await call(app, { url: PV_URL, org: org.cmOrgId })
      expect(ok.statusCode).toBe(200)
      expect(cmCalls).toHaveBeenCalledTimes(1)
      expect(pvCalls).toHaveBeenCalledTimes(mode === 'wrap' ? 1 : 0)
      expect(authenticate).not.toHaveBeenCalled()
    }
  )

  it('replaceSecurity that drops delegation restores authenticate and removes the stages', async () => {
    const { app, authenticate, runtime } = await bootOverride('replace', delegatedPv, {
      writeAuditEvent: false,
    })
    const res = await call(app, { url: PV_URL, org: org.cmOrgId })
    expect(authenticate).toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).not.toMatchObject({ code: 'delegation_invalid' })
    expect(runtime.registry.get(PV_KEY)?.delegation).toBe(false)
  })

  it('replaceSecurity that adds delegation installs the stages and skips authenticate', async () => {
    const { app, authenticate, cmCalls, runtime } = await bootOverride(
      'replace',
      { requireAuth: true, writeAuditEvent: false },
      { delegation: true, writeAuditEvent: false }
    )
    const rejected = await call(app, { url: PV_URL, org: org.cmOrgId, authorization: null })
    expect(JSON.parse(rejected.body)).toMatchObject({ code: 'delegation_invalid' })
    const ok = await call(app, { url: PV_URL, org: org.cmOrgId })
    expect(ok.statusCode).toBe(200)
    expect(cmCalls).toHaveBeenCalledTimes(1)
    expect(authenticate).not.toHaveBeenCalled()
    expect(runtime.registry.get(PV_KEY)?.delegation).toBe(true)
  })

  it('runs CM prepend hooks before the PV stages, and a prepended hook cannot make a rejection reach the handler', async () => {
    const { app, order, cmCalls } = await bootOverride('replace', delegatedPv, undefined, {
      prepend: ['onRequest'],
      append: ['preHandler'],
    })
    const rejected = await call(app, { url: PV_URL, org: org.cmOrgId, authorization: null })
    expect(rejected.statusCode).toBe(401)
    expect(order).toEqual([CM_ON_REQUEST])
    expect(cmCalls).not.toHaveBeenCalled()
    order.length = 0
    const ok = await call(app, { url: PV_URL, org: org.cmOrgId })
    expect(ok.statusCode).toBe(200)
    expect(order).toEqual([CM_ON_REQUEST, 'cm-pre-handler'])
  })

  it('applies the same stages to a raw PV route replaced with replaceSecurity (secureRawRouteReplacement)', async () => {
    const cmCalls = vi.fn()
    const rawCalls = vi.fn()
    const state = loadedApiRoutesState(
      {
        override: [
          {
            method: 'POST',
            url: RAW_URL,
            mode: 'replace',
            replaceSecurity: true,
            security: { delegation: true, writeAuditEvent: false },
          },
        ],
      },
      {
        'POST /raw/cm-fixture': {
          handler: async () => {
            cmCalls()
            return { cm: true }
          },
        },
      }
    )
    const app = Fastify({ logger: false, routerOptions: { ignoreTrailingSlash: true } })
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    await app.register(authenticatePlugin)
    const runtime = installApiRoutes(app as never, state)
    app.route({
      method: 'POST',
      url: RAW_URL,
      handler: async () => {
        rawCalls()
        return { raw: true }
      },
    })
    await app.after()
    await registerApiRouteAdds(app as never, runtime, {
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      docsEnabled: true,
    })
    await app.ready()
    opened.push(app)
    const rejected = await call(app, {
      url: RAW_URL,
      org: org.cmOrgId,
      authorization: null,
    })
    expect(JSON.parse(rejected.body)).toMatchObject({ code: 'delegation_invalid' })
    const ok = await call(app, { url: RAW_URL, org: org.cmOrgId })
    expect(ok.statusCode).toBe(200)
    expect(cmCalls).toHaveBeenCalledTimes(1)
    expect(rawCalls).not.toHaveBeenCalled()
  })
})

describe('Story 71.3 AC-4 — body binding (bsh), encoding and content-length', () => {
  it('passes the parsed body to the handler when bsh matches the exact raw bytes', async () => {
    const { app, seen } = await boot()
    const linked = await linkDelegationActor(org.orgId, ACTOR_SUB, { role: 'member' })
    const res = await call(app, { org: org.cmOrgId, body: { a: 1, text: 'héllo' } })
    expect(res.statusCode).toBe(200)
    expect(seen[0]?.body).toEqual({ a: 1, text: 'héllo' })
    expect(linked.userId).toBeTruthy()
  })

  it('rejects a one-byte body change with 400 delegation_body_mismatch and never calls the handler', async () => {
    const { app, seen } = await boot()
    const original = JSON.stringify({ amount: 100 })
    const token = signDelegationAssertion({
      org: org.cmOrgId,
      sub: ACTOR_SUB,
      op: KEY,
      body: original,
    })
    const burnSpy = vi.spyOn(replayStore, 'burnDelegationAssertion')
    const before = counterValue('body_mismatch')
    const res = await call(app, { org: org.cmOrgId, body: JSON.stringify({ amount: 101 }), token })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_body_mismatch' })
    expect(seen).toHaveLength(0)
    expect(burnSpy).not.toHaveBeenCalled()
    expect(counterValue('body_mismatch')).toBe(before + 1)
  })

  it('hashes the empty byte string for a bodyless request', async () => {
    const { app, seen } = await boot()
    const res = await call(app, { org: org.cmOrgId })
    expect(res.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    expect(bodyHashOf('')).toHaveLength(43)
  })

  it('serves a delegated GET route: no body stream hangs, and a body hash of the empty string is required', async () => {
    const { app, seen } = await boot({
      method: 'GET',
      url: '/cm/read',
      security: { delegation: true },
    })
    const ok = await call(app, { method: 'GET', url: '/cm/read', org: org.cmOrgId })
    expect(ok.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    const wrongHash = await call(app, {
      method: 'GET',
      url: '/cm/read',
      org: org.cmOrgId,
      assertion: { claims: { bsh: bodyHashOf('not empty') } },
    })
    expect(wrongHash.statusCode).toBe(400)
    expect(JSON.parse(wrongHash.body)).toMatchObject({ code: 'delegation_body_mismatch' })
    expect(seen).toHaveLength(1)
  })

  it('compares bsh by exact string equality (a lenient base64url variant does not match)', async () => {
    const { app, seen } = await boot()
    const body = JSON.stringify({ x: 1 })
    const hash = bodyHashOf(body)
    const res = await call(app, {
      org: org.cmOrgId,
      body,
      assertion: { claims: { bsh: hash.replaceAll('-', '+').replaceAll('_', '/') + '=' } },
    })
    // Either the verifier rejects the non-canonical claim or the exact compare does; never a pass.
    expect([400, 401]).toContain(res.statusCode)
    expect(seen).toHaveLength(0)
  })

  it('rejects any Content-Encoding other than identity with 415 before hashing', async () => {
    const { app, seen } = await boot()
    const body = JSON.stringify({ a: 1 })
    const res = await call(app, {
      org: org.cmOrgId,
      body,
      headers: { 'content-encoding': 'gzip' },
    })
    expect(res.statusCode).toBe(415)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_unsupported_encoding' })
    expect(seen).toHaveLength(0)
    const identity = await call(app, {
      org: org.cmOrgId,
      body,
      headers: { 'content-encoding': 'identity' },
    })
    expect(identity.statusCode).toBe(200)
  })

  it('lets Fastify answer 400 for a wrong Content-Length instead of hanging or passing', async () => {
    const { app, seen } = await boot()
    const body = JSON.stringify({ a: 1 })
    const res = await call(app, {
      org: org.cmOrgId,
      body,
      headers: { 'content-length': String(Buffer.byteLength(body) + 5) },
    })
    expect(res.statusCode).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('rejects a body larger than the route bodyLimit as Fastify does today, before any assertion is trusted', async () => {
    const { app, seen } = await boot({ bodyLimit: 64 })
    const body = JSON.stringify({ filler: 'x'.repeat(200) })
    const res = await call(app, { org: org.cmOrgId, body })
    expect(res.statusCode).toBe(413)
    expect(seen).toHaveLength(0)
  })
})

describe('Story 71.3 AC-4 — a streamed body is bounded by bodyLimit while hashing', () => {
  it('answers 413 for a body that exceeds bodyLimit without declaring a Content-Length', async () => {
    const { app, seen } = await boot({ bodyLimit: 64 })
    const body = JSON.stringify({ filler: 'y'.repeat(300) })
    const token = signDelegationAssertion({ org: org.cmOrgId, sub: ACTOR_SUB, op: KEY, body })
    const res = await app.inject({
      method: 'POST',
      url: URL_PATH,
      payload: Readable.from([Buffer.from(body)]),
      headers: { ...JSON_HEADERS, authorization: `PV-Delegation ${token}` },
    })
    expect(res.statusCode).toBe(413)
    expect(seen).toHaveLength(0)
  })
})

describe('Story 71.3 review — an oversized declared body can never skip the body binding', () => {
  it('answers 413 for a GET whose declared Content-Length exceeds bodyLimit instead of skipping the hash', async () => {
    const { app, seen } = await boot({
      method: 'GET',
      url: '/cm/read',
      security: { delegation: true },
      bodyLimit: 64,
    })
    const res = await call(app, {
      method: 'GET',
      url: '/cm/read',
      org: org.cmOrgId,
      body: 'z'.repeat(300),
      assertion: { claims: { bsh: bodyHashOf('') } },
    })
    expect(res.statusCode).toBe(413)
    expect(seen).toHaveLength(0)
  })
})

describe('Story 71.3 AC-4 — subject binding (check 10)', () => {
  const SUBJECTS = {
    delegation: {
      subjectFields: {
        org: { in: 'body', name: 'orgRef' },
        actor: { in: 'body', name: 'actorRef' },
      },
    },
  }
  const bodySchema = { body: z.object({ orgRef: z.unknown().optional() }).passthrough() }

  it('passes when the declared fields equal the assertion values or are absent', async () => {
    const { app, seen } = await boot({
      security: { ...SUBJECTS, writeAuditEvent: false },
      schema: bodySchema,
    })
    const equal = await call(app, {
      org: org.cmOrgId,
      body: { orgRef: org.cmOrgId, actorRef: ACTOR_SUB },
    })
    expect(equal.statusCode).toBe(200)
    const absent = await call(app, { org: org.cmOrgId, body: { other: 1 } })
    expect(absent.statusCode).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('rejects a different org or actor with 400 delegation_subject_mismatch, echoing neither value, plus a security event', async () => {
    const { app, seen } = await boot({
      security: { ...SUBJECTS, writeAuditEvent: false },
      schema: bodySchema,
    })
    const since = new Date()
    const other = await createDelegationOrg('other')
    const res = await call(app, {
      org: org.cmOrgId,
      body: { orgRef: other.cmOrgId, actorRef: ACTOR_SUB },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_subject_mismatch' })
    expect(res.body).not.toContain(other.cmOrgId)
    expect(res.body).not.toContain(org.cmOrgId)
    const actorRes = await call(app, {
      org: org.cmOrgId,
      body: { orgRef: org.cmOrgId, actorRef: 'someone-else' },
    })
    expect(actorRes.statusCode).toBe(400)
    expect(actorRes.body).not.toContain('someone-else')
    expect(seen).toHaveLength(0)
    expect((await securityEvents('subject_mismatch', since)).length).toBeGreaterThanOrEqual(2)
    expect(await countBurnedAssertions(other.orgId)).toBe(0)
  })

  it('treats a non-string value for a declared field as a mismatch', async () => {
    const { app, seen } = await boot({
      security: { ...SUBJECTS, writeAuditEvent: false },
      schema: bodySchema,
    })
    const res = await call(app, { org: org.cmOrgId, body: { orgRef: 42 } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_subject_mismatch' })
    expect(seen).toHaveLength(0)
  })

  it('reads own properties only: an inherited name such as toString is never read (DW-528)', async () => {
    const { app, seen } = await boot({
      security: {
        delegation: { subjectFields: { org: { in: 'body', name: 'toString' } } },
        writeAuditEvent: false,
      },
    })
    const res = await call(app, { org: org.cmOrgId, body: { other: 1 } })
    expect(res.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it('checks a path parameter field against the assertion', async () => {
    const url = '/cm/orgs/:orgRef/events'
    const security = {
      delegation: { subjectFields: { org: { in: 'params', name: 'orgRef' } } },
      writeAuditEvent: false,
    }
    const { app, seen } = await boot({ url, security })
    const ok = await call(app, {
      url: `/cm/orgs/${org.cmOrgId}/events`,
      op: `POST ${url}`,
      org: org.cmOrgId,
    })
    expect(ok.statusCode).toBe(200)
    const bad = await call(app, {
      url: '/cm/orgs/not-this-org/events',
      op: `POST ${url}`,
      org: org.cmOrgId,
    })
    expect(bad.statusCode).toBe(400)
    expect(JSON.parse(bad.body)).toMatchObject({ code: 'delegation_subject_mismatch' })
    expect(seen).toHaveLength(1)
  })
})

describe('Story 71.3 AC-5/AC-6 — org resolution, burn, actor resolution and the delegated context', () => {
  it('answers 421 delegation_org_not_served for an unknown org, without burning', async () => {
    const { app, seen } = await boot()
    const burnSpy = vi.spyOn(replayStore, 'burnDelegationAssertion')
    const before = counterValue('org_not_served')
    const res = await call(app, { org: `cm-org-${randomUUID()}` })
    expect(res.statusCode).toBe(421)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_org_not_served' })
    expect(burnSpy).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
    expect(counterValue('org_not_served')).toBe(before + 1)
  })

  it('answers 503 service_unavailable when the org lookup fails, without burning', async () => {
    const { app, seen } = await boot()
    vi.spyOn(orgService, 'resolveOrgByCentralizemeId').mockRejectedValueOnce(new Error('db down'))
    const burnSpy = vi.spyOn(replayStore, 'burnDelegationAssertion')
    const res = await call(app, { org: org.cmOrgId })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'service_unavailable' })
    expect(burnSpy).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it('answers 503 service_unavailable when the actor lookup fails (after the burn)', async () => {
    const { app, seen } = await boot()
    vi.spyOn(actorModule, 'resolveDelegatedActor').mockRejectedValueOnce(new Error('db down'))
    const jti = `jti-actor-down-${randomUUID()}`
    const res = await call(app, { org: org.cmOrgId, assertion: { claims: { jti } } })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'service_unavailable' })
    expect(await countBurnedAssertions(org.orgId, jti)).toBe(1)
    expect(seen).toHaveLength(0)
  })

  it('burns with the RESOLVED org uuid after org resolution and before actor lookup, outside the handler', async () => {
    const { app } = await boot()
    const order: string[] = []
    const realOrg = orgService.resolveOrgByCentralizemeId
    const realBurn = replayStore.burnDelegationAssertion
    const realActor = actorModule.resolveDelegatedActor
    vi.spyOn(orgService, 'resolveOrgByCentralizemeId').mockImplementation(async (id) => {
      order.push('org')
      return realOrg(id)
    })
    const burn = vi
      .spyOn(replayStore, 'burnDelegationAssertion')
      .mockImplementation(async (input) => {
        order.push('burn')
        return realBurn(input)
      })
    vi.spyOn(actorModule, 'resolveDelegatedActor').mockImplementation(async (input) => {
      order.push('actor')
      return realActor(input)
    })
    const res = await call(app, { org: org.cmOrgId })
    expect(res.statusCode).toBe(200)
    expect(order).toEqual(['org', 'burn', 'actor'])
    expect(burn.mock.calls[0]?.[0]).toMatchObject({ orgId: org.orgId, kid: DELEGATION_TEST_KID })
  })

  it('answers 409 delegation_replayed for a second presentation and exactly one 2xx for two concurrent ones', async () => {
    const { app, seen } = await boot()
    const since = new Date()
    const token = signDelegationAssertion({ org: org.cmOrgId, sub: ACTOR_SUB, op: KEY })
    const first = await call(app, { org: org.cmOrgId, token })
    const second = await call(app, { org: org.cmOrgId, token })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
    expect(JSON.parse(second.body)).toMatchObject({ code: 'delegation_replayed' })
    expect(seen).toHaveLength(1)
    // The event carries the RESOLVED org id (known after check 11), never the CentralizeMe id.
    const events = await securityEvents('replayed', since)
    expect(events.at(-1)?.payload).toMatchObject({ orgId: org.orgId, kid: DELEGATION_TEST_KID })
    expect(JSON.stringify(events.at(-1)?.payload)).not.toContain(org.cmOrgId)

    const racing = signDelegationAssertion({ org: org.cmOrgId, sub: ACTOR_SUB, op: KEY })
    const results = await Promise.all([
      call(app, { org: org.cmOrgId, token: racing }),
      call(app, { org: org.cmOrgId, token: racing }),
    ])
    const codes = results.map((res) => res.statusCode).sort()
    expect(codes).toEqual([200, 409])
  })

  it('answers 503 with Retry-After when the replay store is unavailable, and 500 for a burn input error', async () => {
    const { app, seen } = await boot()
    vi.spyOn(replayStore, 'burnDelegationAssertion').mockResolvedValueOnce({
      outcome: 'store_unavailable',
      sqlState: '57014',
    })
    const unavailable = await call(app, { org: org.cmOrgId })
    expect(unavailable.statusCode).toBe(503)
    expect(JSON.parse(unavailable.body)).toMatchObject({
      code: 'delegation_replay_store_unavailable',
    })
    expect(Number(unavailable.headers['retry-after'])).toBeGreaterThan(0)
    vi.spyOn(replayStore, 'burnDelegationAssertion').mockRejectedValueOnce(
      new replayStore.DelegationBurnInputError('jti', 'must be a string')
    )
    const broken = await call(app, { org: org.cmOrgId })
    expect(broken.statusCode).toBe(500)
    expect(seen).toHaveLength(0)
  })

  it('maps a burn that never resolves to 503 within the request deadline (DW-519 item 1)', async () => {
    const { app, seen } = await boot()
    vi.spyOn(replayStore, 'burnDelegationAssertion').mockImplementationOnce(
      () => new Promise(() => undefined)
    )
    const started = Date.now()
    const res = await call(app, { org: org.cmOrgId })
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_replay_store_unavailable' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(stages.DELEGATION_BURN_DEADLINE_MS - 50)
    expect(Date.now() - started).toBeLessThan(stages.DELEGATION_BURN_DEADLINE_MS + 2000)
    expect(seen).toHaveLength(0)
  }, 15_000)

  it('admits a linked active member as pv_verified with the membership role and the exact ctx.delegation shape', async () => {
    const memberOrg = await createDelegationOrg('member')
    const sub = `user_${randomUUID()}`
    const { userId } = await linkDelegationActor(memberOrg.orgId, sub, { role: 'admin' })
    const { app, seen } = await boot()
    const token = signDelegationAssertion({ org: memberOrg.cmOrgId, sub, op: KEY })
    const res = await call(app, { org: memberOrg.cmOrgId, sub, token })
    expect(res.statusCode).toBe(200)
    const ctx = seen[0]?.ctx as Record<string, never>
    expect(ctx['auth']).toEqual({
      userId,
      orgId: memberOrg.orgId,
      sessionId: 'delegation',
      jti: expect.any(String),
      sessionVersion: 0,
      orgRole: 'admin',
      isPlatformOperator: false,
      delegation: true,
    })
    expect(ctx['delegation']).toEqual({
      orgId: memberOrg.orgId,
      actorId: sub,
      actorProvider: 'centralizeme-handoff',
      actorUserId: userId,
      actorAttestation: 'pv_verified',
      delegatedBy: { kid: DELEGATION_TEST_KID, issuer: 'https://app.centralizeme.com' },
      assertionId: expect.stringMatching(/^jti-/),
      issuedAt: expect.any(Number),
      operation: KEY,
    })
    expect(seen[0]?.orgSetting).toBe(memberOrg.orgId)
  })

  it('admits an unlinked actor as issuer_attested with no user, no role and the nil sentinel userId', async () => {
    const before = counterValue('actor_unlinked')
    const { app, seen } = await boot()
    const res = await call(app, { org: org.cmOrgId, sub: `user_unlinked_${randomUUID()}` })
    expect(res.statusCode).toBe(200)
    const ctx = seen[0]?.ctx as Record<string, Record<string, unknown>>
    expect(ctx['delegation']).toMatchObject({
      actorUserId: null,
      actorAttestation: 'issuer_attested',
    })
    expect(ctx['auth']).toMatchObject({ userId: NIL_UUID, delegation: true })
    expect(ctx['auth']).not.toHaveProperty('orgRole')
    expect(stages.DELEGATION_NIL_USER_ID).toBe(NIL_UUID)
    expect(counterValue('actor_unlinked')).toBeGreaterThan(before)
  })

  it('rejects a linked actor who is not an active member (deactivated or no membership row) with 403', async () => {
    const { app, seen } = await boot()
    const deactivatedSub = `user_${randomUUID()}`
    await linkDelegationActor(org.orgId, deactivatedSub, { membership: 'deactivated' })
    const noRowSub = `user_${randomUUID()}`
    await linkDelegationActor(org.orgId, noRowSub, { membership: 'none' })
    await inSequence([deactivatedSub, noRowSub], async (sub) => {
      const burnedBefore = await countBurnedAssertions(org.orgId)
      const res = await call(app, { org: org.cmOrgId, sub })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_actor_not_member' })
      // The burn precedes actor lookup, so the assertion is consumed (by design).
      expect(await countBurnedAssertions(org.orgId)).toBe(burnedBefore + 1)
    })
    expect(seen).toHaveLength(0)
  })

  it('treats a subject linked only in ANOTHER org as unlinked here (RLS hides the foreign row)', async () => {
    const orgB = await createDelegationOrg('b')
    const sub = `user_${randomUUID()}`
    await linkDelegationActor(orgB.orgId, sub, { role: 'owner' })
    const { app, seen } = await boot()
    const res = await call(app, { org: org.cmOrgId, sub })
    expect(res.statusCode).toBe(200)
    expect((seen[0]?.ctx['delegation'] as { actorUserId: unknown }).actorUserId).toBeNull()
  })

  it('never lets an assertion for org A touch org B: the burn row, RLS org and ctx are A only', async () => {
    const orgA = await createDelegationOrg('cross-a')
    const orgB = await createDelegationOrg('cross-b')
    const { app, seen } = await boot()
    const token = signDelegationAssertion({ org: orgA.cmOrgId, sub: ACTOR_SUB, op: KEY })
    const res = await call(app, {
      org: orgA.cmOrgId,
      token,
      headers: { 'x-org-id': orgB.orgId, 'x-pv-org': orgB.cmOrgId },
    })
    expect(res.statusCode).toBe(200)
    expect(seen[0]?.orgSetting).toBe(orgA.orgId)
    expect((seen[0]?.ctx['delegation'] as { orgId: string }).orgId).toBe(orgA.orgId)
    expect(await countBurnedAssertions(orgA.orgId)).toBe(1)
    expect(await countBurnedAssertions(orgB.orgId)).toBe(0)
  })

  it('creates no session row and never calls the session activity or refresh paths', async () => {
    const touchSession = vi.spyOn(sessionActivity, 'touchSessionActivity')
    const touchMembership = vi.spyOn(sessionActivity, 'touchOrgMembershipActivity')
    const sessionsBefore = await getDb().select({ id: sessions.id }).from(sessions)
    const { app, seen } = await boot()
    const linkedSub = `user_${randomUUID()}`
    await linkDelegationActor(org.orgId, linkedSub)
    expect((await call(app, { org: org.cmOrgId, sub: linkedSub })).statusCode).toBe(200)
    expect((await call(app, { org: org.cmOrgId })).statusCode).toBe(200)
    expect(seen).toHaveLength(2)
    expect(touchSession).not.toHaveBeenCalled()
    expect(touchMembership).not.toHaveBeenCalled()
    const sessionsAfter = await getDb().select({ id: sessions.id }).from(sessions)
    expect(sessionsAfter).toHaveLength(sessionsBefore.length)
  })

  it('keeps the assertion burned when the handler transaction rolls back', async () => {
    const jti = `jti-rollback-${randomUUID()}`
    const { app } = await boot({
      handler: async () => {
        throw new Error('handler failed after the burn')
      },
    })
    const res = await call(app, { org: org.cmOrgId, assertion: { claims: { jti } } })
    expect(res.statusCode).toBe(500)
    expect(await countBurnedAssertions(org.orgId, jti)).toBe(1)
  })

  it('binds the request context with the org, and a real user only for a linked member', async () => {
    const contexts: Array<ReturnType<typeof getRequestContext>> = []
    const { app } = await boot({
      handler: async () => {
        contexts.push(getRequestContext())
        return { ok: true }
      },
    })
    const sub = `user_${randomUUID()}`
    const { userId } = await linkDelegationActor(org.orgId, sub)
    await call(app, { org: org.cmOrgId, sub })
    await call(app, { org: org.cmOrgId, sub: `user_${randomUUID()}` })
    expect(contexts[0]).toMatchObject({ orgId: org.orgId, userId })
    expect(contexts[1]?.orgId).toBe(org.orgId)
    expect(contexts[1]?.userId).toBeUndefined()
  })

  it('rejects an unlinked actor on a route that declares a role requirement with 403 insufficient_role', async () => {
    const { app, seen } = await boot({
      security: { delegation: true, minimumRole: 'member', writeAuditEvent: false },
    })
    const unlinked = await call(app, { org: org.cmOrgId, sub: `user_${randomUUID()}` })
    expect(unlinked.statusCode).toBe(403)
    expect(JSON.parse(unlinked.body)).toMatchObject({ code: 'insufficient_role' })
    const viewerSub = `user_${randomUUID()}`
    await linkDelegationActor(org.orgId, viewerSub, { role: 'viewer' })
    const viewer = await call(app, { org: org.cmOrgId, sub: viewerSub })
    expect(viewer.statusCode).toBe(403)
    const memberSub = `user_${randomUUID()}`
    await linkDelegationActor(org.orgId, memberSub, { role: 'member' })
    const member = await call(app, { org: org.cmOrgId, sub: memberSub })
    expect(member.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
  })

  it('keeps the 71-4 historical-admission seam closed for a route with no historical policy', async () => {
    expect(stages.resolveHistoricalAdmission({ policy: undefined, occurredAt: 1 })).toEqual({
      admitted: false,
    })
  })
})

describe('Story 71.3 AC-8 — security events, metrics and log hygiene', () => {
  it('writes a payload with reason, route, org, kid and a hashed jti, never the assertion, subject or body', async () => {
    const { app } = await boot()
    const since = new Date()
    const sub = 'leaky-subject-sentinel'
    const jti = `jti-${randomUUID()}`
    const token = signDelegationAssertion({ org: org.cmOrgId, sub, op: 'POST /x' })
    const res = await call(app, { org: org.cmOrgId, sub, token, assertion: { claims: { jti } } })
    expect(res.statusCode).toBe(403)
    const rows = await securityEvents('operation_mismatch', since)
    const row = rows.at(-1)
    expect(row).toBeDefined()
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(sub)
    expect(serialized).not.toContain(jti)
    expect(row?.payload).toMatchObject({
      reason: 'operation_mismatch',
      routeKey: KEY,
      kid: DELEGATION_TEST_KID,
    })
    const rejections = await getDb().execute(
      sql`select count(*)::int as n from audit_log_entries where event_type like 'delegation%'`
    )
    expect(Array.from(rejections as never)[0]).toMatchObject({ n: 0 })
  })

  it('swallows a security-event write failure: the response is unchanged and stderr carries no assertion data', async () => {
    const { app } = await boot()
    const keyService = await import('../modules/vault/key-service.js')
    vi.spyOn(keyService, 'getAuditKey').mockImplementation(() => {
      throw new Error('audit key unavailable')
    })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const sub = 'stderr-subject-sentinel'
    const token = signDelegationAssertion({ org: org.cmOrgId, sub, op: 'POST /x' })
    const res = await call(app, { org: org.cmOrgId, sub, token })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_operation_mismatch' })
    const output = written.join('')
    expect(output).toContain('delegation.security_event_write_error')
    expect(output).not.toContain(token)
    expect(output).not.toContain(sub)
  })

  it('never logs the assertion, the header, the actor subject or the body on success or any rejection', async () => {
    const { stream, lines } = createLogCaptureStream()
    const { app } = await boot({ logStream: stream })
    const sub = 'log-hygiene-subject-sentinel'
    const body = { marker: 'log-hygiene-body-sentinel' }
    const goodToken = signDelegationAssertion({
      org: org.cmOrgId,
      sub,
      op: KEY,
      body: JSON.stringify(body),
    })
    const tokens = [goodToken]
    await call(app, { org: org.cmOrgId, sub, body, token: goodToken })
    await call(app, { org: org.cmOrgId, sub, body, token: goodToken })
    await inSequence(
      [{ wrongKey: true }, { claims: { aud: 'pvd:nope' } }, { omit: ['org'] }],
      async (assertion) => {
        const token = signDelegationAssertion(
          { org: org.cmOrgId, sub, op: KEY, body: JSON.stringify(body) },
          assertion
        )
        tokens.push(token)
        await call(app, { org: org.cmOrgId, sub, body, token })
      }
    )
    await call(app, {
      org: org.cmOrgId,
      sub,
      body: { marker: 'log-hygiene-body-sentinel-2' },
      token: goodToken,
    })
    const logged = parseCapturedLogLines(lines)
      .map((line) => JSON.stringify(line))
      .join('\n')
    for (const token of tokens) expect(logged).not.toContain(token)
    expect(logged).not.toContain('PV-Delegation')
    expect(logged).not.toContain(sub)
    expect(logged).not.toContain('log-hygiene-body-sentinel')
  })
})

describe('Story 71.3 AC-7 — the route limiter principal is the resolved org, never the actor', () => {
  beforeAll(() => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  })
  afterAll(() => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  })

  it('shares one bucket across two actors of the same org and separates two orgs', async () => {
    const orgA = await createDelegationOrg('rl-a')
    const orgB = await createDelegationOrg('rl-b')
    const { app } = await boot({
      security: {
        delegation: true,
        writeAuditEvent: false,
        rateLimit: { max: 2, timeWindowMs: 60_000, key: `rl-${randomUUID()}` },
      },
    })
    const statuses = (cmOrg: string, subs: string[]) =>
      inSequence(subs, async (sub) => (await call(app, { org: cmOrg, sub })).statusCode)
    expect(await statuses(orgA.cmOrgId, ['actor-1', 'actor-2', 'actor-3'])).toEqual([200, 200, 429])
    expect(await statuses(orgB.cmOrgId, ['actor-1'])).toEqual([200])
  })
})

// Last on purpose: the per-kid limiter bucket is process-wide state shared by every test above.
describe('Story 71.3 AC-2b/AC-3/AC-7 — rate limiting', () => {
  beforeAll(() => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
  })
  afterAll(() => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  })

  it('applies the built-in per-IP limiter to a delegated route: unauthenticated floods hit 429 before any delegation work (71-9)', async () => {
    // Story 71.9 AC-4: the limiter is installed by the delegation stages themselves, so no
    // app-level limiter is registered here. A dedicated remote address keeps its bucket private.
    const { app } = await boot()
    const budget = stages.DELEGATION_IP_RATE_LIMIT.max
    const codes = await inSequence(
      Array.from({ length: budget + 2 }, (_, index) => index),
      async () => {
        const res = await app.inject({
          method: 'POST',
          url: URL_PATH,
          remoteAddress: '10.20.30.40',
        })
        return res.statusCode
      }
    )
    expect(codes.slice(0, budget).every((code) => code === 401)).toBe(true)
    expect(codes.slice(budget)).toEqual([429, 429])
  }, 60_000)

  it('spends the per-kid limiter before the operation check: an exhausted kid gets 429 and no security event for a wrong-op assertion', async () => {
    const { app, seen } = await boot()
    const bucket = stages.delegationKidBucket(DELEGATION_TEST_KID)
    const sink = { status: () => sink, header: () => sink, send: () => sink }
    for (let used = 0; used < stages.DELEGATION_PRE_BURN_LIMIT.max; used += 1) {
      enforceUserRateLimit({ ...bucket, ...stages.DELEGATION_PRE_BURN_LIMIT, reply: sink as never })
    }
    const since = new Date()
    const res = await call(app, { org: org.cmOrgId, op: 'POST /cm/other-operation' })
    expect(res.statusCode).toBe(429)
    expect(seen).toHaveLength(0)
    expect(await securityEvents('operation_mismatch', since)).toHaveLength(0)
  })

  it('applies the per-kid limiter before any database access: over-limit -> 429 + Retry-After, no burn, no org lookup', async () => {
    const { app, seen } = await boot()
    const bucket = stages.delegationKidBucket(DELEGATION_TEST_KID)
    const sink = {
      status: () => sink,
      header: () => sink,
      send: () => sink,
    }
    for (let used = 0; used < stages.DELEGATION_PRE_BURN_LIMIT.max; used += 1) {
      enforceUserRateLimit({ ...bucket, ...stages.DELEGATION_PRE_BURN_LIMIT, reply: sink as never })
    }
    const orgSpy = vi.spyOn(orgService, 'resolveOrgByCentralizemeId')
    const burnSpy = vi.spyOn(replayStore, 'burnDelegationAssertion')
    const actorSpy = vi.spyOn(actorModule, 'resolveDelegatedActor')
    const before = counterValue('rate_limited_pre')
    const res = await call(app, { org: org.cmOrgId })
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(orgSpy).not.toHaveBeenCalled()
    expect(burnSpy).not.toHaveBeenCalled()
    expect(actorSpy).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
    expect(counterValue('rate_limited_pre')).toBe(before + 1)
    // An unknown kid never reaches the limiter, so it cannot grow limiter state.
    const unknown = await call(app, {
      org: org.cmOrgId,
      assertion: { header: { kid: 'unknown-kid-x' } },
    })
    expect(unknown.statusCode).toBe(401)
  })
})
