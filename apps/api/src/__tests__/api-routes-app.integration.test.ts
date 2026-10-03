import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { configureAuthIntegrationEnv, initVaultForTest } from './helpers/auth-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from './helpers/capture-logs.js'
import { API_ROUTES_FIXTURE_PACKAGE, importApiRoutesFixture } from './helpers/api-routes-fixture.js'

/**
 * Story 68.14 AC-1 / AC-5 — app-level API behaviour (`apiRoutes.app`): the error handler and the
 * not-found handler with wrap/replace, prepended and appended global hooks, the throw-fallback
 * shell, the status endpoint's `app` object and the boot log lines. Every case boots the REAL
 * loader and `createApp()` with one fixture scenario per app (same pattern as
 * api-routes-boot.integration.test.ts).
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = API_ROUTES_FIXTURE_PACKAGE
configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests } = await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const { apiRoutesStatus } = await import('../extensions/api-routes/install.js')
const { env } = await import('../config/env.js')
const fixture = await importApiRoutesFixture()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Scenario = Parameters<typeof fixture.setApiRoutesScenario>[0]
type Decorated = TestApp & { pvApiRouteOverrides?: Parameters<typeof apiRoutesStatus>[0] }
type HookRecord = { phase: string; requestIdHeader: boolean }
type AppObserved = { hookOrder: HookRecord[]; errorHandlerErrors: string[] }

const PROJECTS_URL = '/api/v1/projects'
const ON_REQUEST = 'onRequest'
const HOOKS_PREPEND = 'app-hooks-prepend'
const HOOKS_APPEND = 'app-hooks-append'
const PASSPHRASE = 'api-routes-app-integration-passphrase'
const savedPackage = env.VAULT_EXTENSIONS_PACKAGE
const observed = fixture.observed as unknown as AppObserved
const PV_INTERNAL_ERROR = {
  error: 'internal_error',
  message: 'An unexpected error occurred',
}

async function boot(
  scenario: Scenario | 'none',
  options: { logger?: boolean | object; vaultGuardEnabled?: boolean } = {}
): Promise<Decorated> {
  __resetExtensionStateForTests()
  __resetCapabilityGateForTests()
  __resetAuthStrategiesForTests()
  fixture.resetObserved()
  if (scenario === 'none') {
    Object.assign(env, { VAULT_EXTENSIONS_PACKAGE: undefined })
  } else {
    Object.assign(env, { VAULT_EXTENSIONS_PACKAGE: savedPackage })
    fixture.setApiRoutesScenario(scenario)
  }
  return (await createApp({
    logger: options.logger ?? false,
    vaultGuardEnabled: options.vaultGuardEnabled ?? true,
  })) as Decorated
}

async function withApp(
  scenario: Scenario | 'none',
  run: (app: Decorated) => Promise<void>,
  options: Parameters<typeof boot>[1] = {}
): Promise<void> {
  const app = await boot(scenario, options)
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

function eventLines(lines: string[], eventType: string) {
  return parseCapturedLogLines(lines).filter((line) => line['eventType'] === eventType)
}

async function bareFastify404(method: 'GET' | 'POST' | 'HEAD', url: string) {
  const bare = Fastify({ logger: false })
  await bare.ready()
  const response = await bare.inject({ method, url })
  await bare.close()
  return response
}

describe('Story 68.14 — apiRoutes.app', () => {
  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
  }, 60_000)

  afterEach(() => {
    Object.assign(env, { VAULT_EXTENSIONS_PACKAGE: savedPackage })
  })

  afterAll(async () => {
    __resetExtensionStateForTests()
    fixture.setApiRoutesScenario('default')
    await resetVaultForTest()
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  describe('no extension: PV outputs are unchanged (golden)', () => {
    it.each(['GET', 'POST', 'HEAD'] as const)(
      'the not-found output for %s equals Fastify default 404 byte for byte',
      async (method) => {
        const expected = await bareFastify404(method, '/nope?x=1')
        await withApp('none', async (app) => {
          const actual = await app.inject({ method, url: '/nope?x=1' })
          expect(actual.statusCode).toBe(404)
          expect(actual.body).toBe(expected.body)
          expect(actual.headers['content-type']).toBe(expected.headers['content-type'])
          expect(actual.headers['content-length']).toBe(expected.headers['content-length'])
          if (method === 'GET') {
            expect(actual.json()).toEqual({
              message: 'Route GET:/nope?x=1 not found',
              error: 'Not Found',
              statusCode: 404,
            })
          }
        })
      }
    )

    it('the status object has an empty app section and no table is decorated', async () => {
      await withApp('none', async (app) => {
        expect(app.pvApiRouteOverrides).toBeUndefined()
        expect(apiRoutesStatus(app.pvApiRouteOverrides).app).toEqual({
          errorHandler: null,
          notFoundHandler: null,
          hooks: { prepend: [], append: [] },
        })
      })
    })
  })

  describe('error handler wrap', () => {
    it('maps a CM error to 409 and delegates every other error to PV unchanged', async () => {
      await withApp('app-wrap', async (app) => {
        const cm = await app.inject({ method: 'GET', url: '/cm/boom' })
        expect(cm.statusCode).toBe(409)
        expect(cm.json()).toEqual({ code: 'cm_conflict' })
        const plain = await app.inject({ method: 'GET', url: '/cm/plain-error' })
        expect(plain.statusCode).toBe(500)
        expect(plain.json()).toEqual(PV_INTERNAL_ERROR)
        const status = await app.inject({ method: 'GET', url: '/cm/status-error' })
        expect(status.statusCode).toBe(400)
        expect(status.json()).toEqual({ error: 'validation_error', message: 'bad input' })
      })
    })

    it('a parser error from a PV route keeps PV validation_error shape through the delegating wrap', async () => {
      await withApp('app-wrap', async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: '{bad',
          headers: { 'content-type': 'application/json' },
        })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: 'validation_error' })
        expect(observed.errorHandlerErrors.length).toBeGreaterThan(0)
      })
    })

    it('50 concurrent mixed requests each get the right handler output', async () => {
      await withApp('app-wrap', async (app) => {
        const urls = Array.from({ length: 50 }, (_, index) =>
          index % 2 === 0 ? '/cm/boom' : '/cm/plain-error'
        )
        const responses = await Promise.all(urls.map((url) => app.inject({ method: 'GET', url })))
        responses.forEach((response, index) => {
          if (index % 2 === 0) expect(response.json()).toEqual({ code: 'cm_conflict' })
          else expect(response.json()).toEqual(PV_INTERNAL_ERROR)
        })
      })
    })
  })

  describe('error handler replace', () => {
    it('CM owns the output for CM and PV errors alike', async () => {
      await withApp('app-replace', async (app) => {
        const cm = await app.inject({ method: 'GET', url: '/cm/boom' })
        expect(cm.statusCode).toBe(418)
        expect(cm.json()).toEqual({ code: 'cm_teapot', errorName: 'CmError' })
        const pv = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: '{bad',
          headers: { 'content-type': 'application/json' },
        })
        expect(pv.statusCode).toBe(418)
        expect(pv.json()).toMatchObject({ code: 'cm_teapot' })
      })
    })
  })

  describe('not-found handler', () => {
    it('wrap: a CM JSON 404 for /cm/* and PV default for everything else', async () => {
      const expected = await bareFastify404('GET', '/nope')
      await withApp('app-wrap', async (app) => {
        const cm = await app.inject({ method: 'GET', url: '/cm/zzz' })
        expect(cm.statusCode).toBe(404)
        expect(cm.json()).toEqual({ code: 'cm_not_found' })
        const other = await app.inject({ method: 'GET', url: '/nope' })
        expect(other.statusCode).toBe(404)
        expect(other.body).toBe(expected.body)
      })
    })

    it('replace: CM output for every unknown route', async () => {
      await withApp('app-replace', async (app) => {
        const response = await app.inject({ method: 'GET', url: '/nope' })
        expect(response.json()).toEqual({ code: 'cm_nope' })
      })
    })
  })

  describe('a throwing CM handler falls back to PV with the original error', () => {
    it.each(['app-throwing-wrap', 'app-throwing-replace'] as const)(
      '%s: PV answers, nothing leaks, one app_handler_failed log without message or stack',
      async (scenario) => {
        const logs = createLogCaptureStream()
        await withApp(
          scenario,
          async (app) => {
            const response = await app.inject({ method: 'GET', url: '/cm/boom' })
            expect(response.statusCode).toBe(500)
            expect(response.json()).toEqual(PV_INTERNAL_ERROR)
            expect(response.body).not.toContain('boom')
            const status = await app.inject({ method: 'GET', url: '/cm/status-error' })
            expect(status.json()).toEqual({ error: 'validation_error', message: 'bad input' })
          },
          { logger: { level: 'info', stream: logs.stream } }
        )
        const failures = eventLines(
          logs.lines,
          OperationalEvent.EXTENSION_API_ROUTE_APP_HANDLER_FAILED
        )
        expect(failures).toHaveLength(2)
        for (const line of failures) {
          expect(line['level']).toBe(50)
          expect(line['errorClass']).toBe('TypeError')
          expect(line['handler']).toBe('errorHandler')
          expect(line).not.toHaveProperty('err')
          expect(line).not.toHaveProperty('stack')
          expect(JSON.stringify(line)).not.toContain('boom secret')
        }
        expect(failures.map((line) => line['route'])).toEqual([
          'GET /cm/boom',
          'GET /cm/status-error',
        ])
      }
    )

    it.each(['app-throwing-wrap', 'app-throwing-replace'] as const)(
      '%s: a throwing not-found handler answers with PV default 404',
      async (scenario) => {
        const expected = await bareFastify404('GET', '/nope')
        const logs = createLogCaptureStream()
        await withApp(
          scenario,
          async (app) => {
            const response = await app.inject({ method: 'GET', url: '/nope' })
            expect(response.statusCode).toBe(404)
            expect(response.body).toBe(expected.body)
          },
          { logger: { level: 'info', stream: logs.stream } }
        )
        const failures = eventLines(
          logs.lines,
          OperationalEvent.EXTENSION_API_ROUTE_APP_HANDLER_FAILED
        )
        expect(failures).toHaveLength(1)
        expect(failures[0]?.['handler']).toBe('notFoundHandler')
        expect(failures[0]?.['route']).toBeNull()
      }
    )
  })

  describe('global hooks', () => {
    it('a prepended onRequest hook runs before PV hooks (no X-Request-ID yet) on a child-plugin route', async () => {
      await withApp(HOOKS_PREPEND, async (app) => {
        const response = await app.inject({ method: 'GET', url: PROJECTS_URL })
        expect(response.statusCode).toBe(401)
        expect(observed.hookOrder).toEqual([{ phase: ON_REQUEST, requestIdHeader: false }])
      })
    })

    it('an appended onRequest hook runs after PV hooks on a child-plugin route', async () => {
      await withApp(HOOKS_APPEND, async (app) => {
        const response = await app.inject({ method: 'GET', url: PROJECTS_URL })
        expect(response.statusCode).toBe(401)
        expect(observed.hookOrder).toEqual([{ phase: ON_REQUEST, requestIdHeader: true }])
      })
    })

    it('guard enabled + sealed vault: the prepended hook runs, the appended one does not, PV answers 503', async () => {
      await resetVaultForTest()
      try {
        await withApp(HOOKS_PREPEND, async (app) => {
          const response = await app.inject({ method: 'GET', url: PROJECTS_URL })
          expect(response.statusCode).toBe(503)
          expect(response.json()).toMatchObject({ status: 'sealed' })
          expect(observed.hookOrder).toHaveLength(1)
        })
        await withApp(HOOKS_APPEND, async (app) => {
          const response = await app.inject({ method: 'GET', url: PROJECTS_URL })
          expect(response.statusCode).toBe(503)
          expect(observed.hookOrder).toEqual([])
        })
      } finally {
        await initVaultForTest(initVault, PASSPHRASE)
      }
    })

    it('guard disabled: the append anchor is the empty guard slot, so the hook still runs and PV answers (no 503)', async () => {
      await resetVaultForTest()
      try {
        await withApp(
          HOOKS_APPEND,
          async (app) => {
            const response = await app.inject({ method: 'GET', url: PROJECTS_URL })
            expect(response.statusCode).toBe(401)
            expect(observed.hookOrder).toEqual([{ phase: ON_REQUEST, requestIdHeader: true }])
          },
          { vaultGuardEnabled: false }
        )
      } finally {
        await initVaultForTest(initVault, PASSPHRASE)
      }
    })

    it('a prepended hook that throws is answered by PV with 500 internal_error', async () => {
      await withApp('app-hooks-throw', async (app) => {
        const response = await app.inject({ method: 'GET', url: '/health' })
        expect(response.statusCode).toBe(500)
        expect(response.json()).toEqual(PV_INTERNAL_ERROR)
      })
    })
  })

  describe('recording', () => {
    it('the status helper lists the declared app-level changes', async () => {
      await withApp('app-wrap', async (app) => {
        expect(apiRoutesStatus(app.pvApiRouteOverrides).app).toEqual({
          errorHandler: 'wrap',
          notFoundHandler: 'wrap',
          hooks: { prepend: [], append: [] },
        })
      })
      await withApp(HOOKS_APPEND, async (app) => {
        expect(apiRoutesStatus(app.pvApiRouteOverrides).app.hooks).toEqual({
          prepend: [],
          append: [ON_REQUEST],
        })
      })
    })

    it('logs one app_override warn per declared change and lists them in the applied summary', async () => {
      const logs = createLogCaptureStream()
      await withApp('app-wrap', async () => undefined, {
        logger: { level: 'info', stream: logs.stream },
      })
      const warns = eventLines(logs.lines, OperationalEvent.EXTENSION_API_ROUTE_APP_OVERRIDE)
      expect(warns.map((line) => [line['target'], line['mode']])).toEqual([
        ['errorHandler', 'wrap'],
        ['notFoundHandler', 'wrap'],
      ])
      for (const line of warns) {
        expect(Object.keys(line).sort()).toEqual(
          [
            'eventType',
            'extensionName',
            'level',
            'mode',
            'msg',
            'pid',
            'hostname',
            'target',
            'time',
            'traceId',
          ].sort()
        )
      }
      const [summary] = eventLines(logs.lines, OperationalEvent.EXTENSION_API_ROUTES_APPLIED)
      expect(summary?.['app']).toEqual(['errorHandler wrap', 'notFoundHandler wrap'])
    })

    it('logs one app_override warn per hook phase with its position', async () => {
      const logs = createLogCaptureStream()
      await withApp(HOOKS_PREPEND, async () => undefined, {
        logger: { level: 'info', stream: logs.stream },
      })
      const warns = eventLines(logs.lines, OperationalEvent.EXTENSION_API_ROUTE_APP_OVERRIDE)
      expect(warns.map((line) => [line['target'], line['phase'], line['position']])).toEqual([
        ['hook', ON_REQUEST, 'prepend'],
      ])
    })
  })
})
