import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import type { ModuleDataRequestContext } from '@project-vault/extension-api'
import {
  bootstrapRouteIntegrationTest,
  bootUnsealedRouteApp,
  cookieHeader,
  type CookieJar,
} from '../__tests__/helpers/auth-test-helpers.js'
import { createDirectAuthenticatedUser } from '../__tests__/helpers/org-role-test-helpers.js'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from './loader.js'
import type { ExtensionState } from './loader.js'
import { attemptModuleDataRoute } from './module-data-routes.js'

const { initVault } = await bootstrapRouteIntegrationTest()
const TEST_PASSPHRASE = 'module-data-routes-passphrase'
const MOUNT_PREFIX = '/api/v1/extensions/data'

type TestApp = Awaited<ReturnType<typeof import('../app.js').createApp>>

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}

const CONTEXT: ModuleDataRequestContext = {
  identity: { userId: 'user_1', orgRole: 'member' },
  orgId: 'org_1',
  params: {},
  query: {},
}

describe('attemptModuleDataRoute (Story 29.4 AC5) — failure degradation, unit-level', () => {
  it('happy path: a handler that resolves normally passes its status/body through unchanged', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const outcome = await attemptModuleDataRoute(handler, CONTEXT, silentLogger(), 'GET /x')
    expect(outcome).toEqual({ kind: 'ok', status: 200, body: { ok: true } })
  })

  it('defaults status to 200 when the handler omits it', async () => {
    const handler = vi.fn(async () => ({ body: { ok: true } }))
    const outcome = await attemptModuleDataRoute(handler, CONTEXT, silentLogger(), 'GET /x')
    expect(outcome).toEqual({ kind: 'ok', status: 200, body: { ok: true } })
  })

  it('a thrown error degrades to { kind: "failed", subReason: "threw" } and logs the fixed event without the raw error text', async () => {
    const logger = silentLogger()
    const handler = vi.fn(async () => {
      throw new Error('sensitive db connection string leaked here')
    })
    const outcome = await attemptModuleDataRoute(handler, CONTEXT, logger, 'GET /x')
    expect(outcome).toEqual({ kind: 'failed', subReason: 'threw' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [metadata] = logger.error.mock.calls[0] as [Record<string, unknown>, unknown]
    expect(metadata).toMatchObject({ routeKey: 'GET /x', subReason: 'threw' })
    expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('sensitive')
  })

  it('a timeout degrades to { kind: "failed", subReason: "timed_out" }', async () => {
    vi.useFakeTimers()
    try {
      const handler = vi.fn(() => new Promise<never>(() => undefined))
      const promise = attemptModuleDataRoute(handler, CONTEXT, silentLogger(), 'GET /x', 10_000)
      await vi.advanceTimersByTimeAsync(10_001)
      const outcome = await promise
      expect(outcome).toEqual({ kind: 'failed', subReason: 'timed_out' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a non-object return degrades to { kind: "failed", subReason: "malformed_result" }', async () => {
    const handler = vi.fn(async () => 'not-an-object' as never)
    const outcome = await attemptModuleDataRoute(handler, CONTEXT, silentLogger(), 'GET /x')
    expect(outcome).toEqual({ kind: 'failed', subReason: 'malformed_result' })
  })

  it('an object with body undefined and no status degrades to { kind: "failed", subReason: "malformed_result" }', async () => {
    const handler = vi.fn(async () => ({}) as never)
    const outcome = await attemptModuleDataRoute(handler, CONTEXT, silentLogger(), 'GET /x')
    expect(outcome).toEqual({ kind: 'failed', subReason: 'malformed_result' })
  })
})

describe('GET /api/v1/extensions/data/* — Story 29.4 AC2/AC4/AC9 (real mounted route)', () => {
  let app: TestApp
  let closeApp: () => Promise<void>

  beforeAll(async () => {
    __setExtensionStateForTests(
      loadedStateWithModuleDataRoutes({
        'GET /org/users/:id': async (context: ModuleDataRequestContext) => ({
          body: { orgId: context.orgId, id: context.params.id, q: context.query.q ?? null },
        }),
        'GET /boom': async () => {
          throw new Error('should never leak this text')
        },
      })
    )
    const suite = await bootUnsealedRouteApp(initVault, TEST_PASSPHRASE)
    app = suite.app
    closeApp = suite.close
  })

  afterAll(async () => {
    await closeApp()
    __resetExtensionStateForTests()
  })

  it('AC2: the declared route is mounted under the fixed /api/v1/extensions/data prefix', async () => {
    const member = await createDirectAuthenticatedUser(app, 'moduledata-mount', 'member')
    const res = await app.inject({
      method: 'GET',
      url: `${MOUNT_PREFIX}/org/users/u1`,
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orgId: member.orgId, id: 'u1', q: null })
  })

  it('AC2: a plausible-but-wrong guess omitting /extensions/data 404s exactly like any other undeclared route', async () => {
    const member = await createDirectAuthenticatedUser(app, 'moduledata-wrong-guess', 'member')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/org/users/u1',
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('AC4: an unauthenticated request 401s before the handler is ever invoked', async () => {
    const res = await app.inject({ method: 'GET', url: `${MOUNT_PREFIX}/org/users/u1` })
    expect(res.statusCode).toBe(401)
  })

  it('AC9: query parameters are threaded through to the handler', async () => {
    const member = await createDirectAuthenticatedUser(app, 'moduledata-query', 'member')
    const res = await app.inject({
      method: 'GET',
      url: `${MOUNT_PREFIX}/org/users/u2?q=hello`,
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ orgId: member.orgId, id: 'u2', q: 'hello' })
  })

  it("AC9: concurrent requests from different orgs each receive their own orgId, never the other's", async () => {
    const [memberA, memberB] = await Promise.all([
      createDirectAuthenticatedUser(app, 'moduledata-org-a', 'member'),
      createDirectAuthenticatedUser(app, 'moduledata-org-b', 'member'),
    ])

    const request = (member: { cookies: CookieJar; orgId: string }) =>
      app
        .inject({
          method: 'GET',
          url: `${MOUNT_PREFIX}/org/users/self`,
          headers: { cookie: cookieHeader(member.cookies) },
        })
        .then((res) => ({ res, orgId: member.orgId }))

    const [resultA, resultB] = await Promise.all([request(memberA), request(memberB)])

    expect(resultA.res.json()).toEqual({ orgId: resultA.orgId, id: 'self', q: null })
    expect(resultB.res.json()).toEqual({ orgId: resultB.orgId, id: 'self', q: null })
    expect(resultA.orgId).not.toBe(resultB.orgId)
  })

  it('AC5: a throwing handler produces the fixed, non-leaking 502 body over real HTTP', async () => {
    const member = await createDirectAuthenticatedUser(app, 'moduledata-boom', 'member')
    const res = await app.inject({
      method: 'GET',
      url: `${MOUNT_PREFIX}/boom`,
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      code: 'module_data_unavailable',
      message: 'This data is temporarily unavailable.',
    })
    expect(JSON.stringify(res.json())).not.toContain('should never leak this text')
  })
})

describe('GET /api/v1/extensions/data/* — Story 29.4 AC4 (no extension loaded)', () => {
  let app: TestApp
  let closeApp: () => Promise<void>

  beforeAll(async () => {
    __resetExtensionStateForTests()
    const suite = await bootUnsealedRouteApp(initVault, TEST_PASSPHRASE)
    app = suite.app
    closeApp = suite.close
  })

  afterAll(async () => {
    await closeApp()
  })

  it('mounts zero routes when no extension is loaded: any path under the prefix 404s, not 503', async () => {
    const member = await createDirectAuthenticatedUser(app, 'moduledata-unloaded', 'member')
    const res = await app.inject({
      method: 'GET',
      url: `${MOUNT_PREFIX}/anything`,
      headers: { cookie: cookieHeader(member.cookies) },
    })
    expect(res.statusCode).toBe(404)
  })
})

function loadedStateWithModuleDataRoutes(
  moduleData: Record<string, (context: ModuleDataRequestContext) => Promise<unknown>>
): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.example.module-data-fixture',
      apiVersion: '1.0.0',
      capabilities: ['ui-panel'],
      moduleDataRoutes: Object.keys(moduleData).map((key) => {
        const [, path] = key.split(' ') as [string, string]
        return { method: 'GET' as const, path }
      }),
    },
    loadedAt: new Date().toISOString(),
    hooks: { moduleData: moduleData as never },
  }
}
