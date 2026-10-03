import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { configureAuthIntegrationEnv, initVaultForTest } from './helpers/auth-test-helpers.js'
import { createLogCaptureStream, parseCapturedLogLines } from './helpers/capture-logs.js'
import { API_ROUTES_FIXTURE_PACKAGE, importApiRoutesFixture } from './helpers/api-routes-fixture.js'

/**
 * Story 68.8 AC-5, AC-6, AC-9, AC-10, AC-11, AC-14 (boot rows), AC-18/AC-19 tripwires — every
 * boot outcome of the apiRoutes mechanism through the REAL loader and `createApp()`, one fixture
 * scenario per app. `env` is the already-parsed singleton, mutated per test and restored (the
 * established pattern, e.g. session-revoke-org-wide.test.ts), so one file can cover every
 * VAULT_EXTENSIONS_REQUIRED combination without re-importing the module graph.
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = API_ROUTES_FIXTURE_PACKAGE
configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests, getExtensionStatus } =
  await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const { ExtensionRequiredError } = await import('../extensions/boot-errors.js')
const { ExtensionApiRouteBootError } = await import('../lib/secure-route-overrides.js')
const { apiRoutesStatus } = await import('../extensions/api-routes/install.js')
const { reportStartupFailure } = await import('../lib/startup-logging.js')
const { env } = await import('../config/env.js')
const fixture = await importApiRoutesFixture()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Scenario = Parameters<typeof fixture.setApiRoutesScenario>[0]
type Registration = {
  key: string
  origin: string
  rateLimitKey: string | null
  rateLimitKeyIsDefault: boolean
  defaultAuditEventType: string | null
}
type Decorated = TestApp & {
  pvApiRouteOverrides?: Parameters<typeof apiRoutesStatus>[0]
  pvSecureRouteRegistry: Map<string, Registration>
  pvRouteIndex: Set<string>
}

const PASSPHRASE = 'api-routes-boot-integration-passphrase'
const savedEnv = {
  VAULT_EXTENSIONS_PACKAGE: env.VAULT_EXTENSIONS_PACKAGE,
  VAULT_EXTENSIONS_REQUIRED: env.VAULT_EXTENSIONS_REQUIRED,
  VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST: env.VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST,
}

const ABOVE_HOST = 'above-host'

function resetExtensionWorld(scenario: Scenario): void {
  __resetExtensionStateForTests()
  __resetCapabilityGateForTests()
  __resetAuthStrategiesForTests()
  fixture.setApiRoutesScenario(scenario)
  fixture.resetObserved()
}

async function boot(scenario: Scenario, logger: boolean | object = false): Promise<Decorated> {
  resetExtensionWorld(scenario)
  return (await createApp({ logger, vaultGuardEnabled: true })) as Decorated
}

async function bootFailure(scenario: Scenario): Promise<Error> {
  let caught: unknown
  try {
    const app = await boot(scenario)
    await app.close()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  return caught as Error
}

describe('Story 68.8 — apiRoutes boot outcomes', () => {
  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, PASSPHRASE)
  }, 60_000)

  afterEach(() => {
    Object.assign(env, savedEnv)
  })

  afterAll(async () => {
    resetExtensionWorld('default')
    await resetVaultForTest()
    delete process.env['VAULT_EXTENSIONS_PACKAGE']
  })

  describe('AC-10 — drift and collisions fail the boot (never fail-open)', () => {
    it('missing override targets: ExtensionApiRouteBootError listing every key, sorted, with hints', async () => {
      const error = await bootFailure('missing-target')
      expect(error).toBeInstanceOf(ExtensionApiRouteBootError)
      expect(error.message).toBe(
        'apiRoutes.override targets not found: GET /api/v1/projects/:id (PV has GET /api/v1/projects/:projectId), PATCH /api/v1/nope (no PV route); the API cannot start with a partially applied extension'
      )
    })

    it('startup.failed carries the sibling extension reason (Q15)', async () => {
      const error = await bootFailure('missing-target')
      const { stream, lines } = createLogCaptureStream()
      await reportStartupFailure(
        { NODE_ENV: 'test', LOG_LEVEL: 'silent', SERVICE_NAME: 'api' } as never,
        error,
        stream
      )
      const [line] = parseCapturedLogLines(lines)
      expect(line?.['eventType']).toBe(OperationalEvent.STARTUP_FAILED)
      expect(line?.['extension']).toEqual({ reason: 'extension_api_route_drift' })
      expect(line).not.toHaveProperty('cause')
    })

    it('an undeclared collision: ExtensionApiRouteBootError naming the override fix', async () => {
      const error = await bootFailure('collision')
      expect(error).toBeInstanceOf(ExtensionApiRouteBootError)
      expect((error as InstanceType<typeof ExtensionApiRouteBootError>).reason).toBe(
        'extension_api_route_collision'
      )
      expect(error.message).toContain(
        "declare it under apiRoutes.override with mode 'replace' or 'wrap'"
      )
    })
  })

  it('AC-5: a schema the host compiler rejects fails inside createApp(), before any listen()', async () => {
    const error = await bootFailure('bad-schema')
    expect(error).toBeInstanceOf(ExtensionApiRouteBootError)
    expect(error.message).toBe(
      'apiRoutes override GET /api/v1/projects/:projectId: schema rejected by the host compiler: response.200 is not a schema the host compiler accepts (expected a Zod 4 schema)'
    )
  })

  describe('AC-9 / AC-11 — negotiation, fail-open default and VAULT_EXTENSIONS_REQUIRED', () => {
    it('above-host pack: hooksFactory never runs, no override applies, the API boots fail-open', async () => {
      const app = await boot(ABOVE_HOST)
      try {
        expect(fixture.observed.hooksFactoryCalls).toBe(0)
        expect(getExtensionStatus()).toEqual({
          status: 'load_failed',
          reason: 'capability_mismatch',
        })
        expect(app.pvApiRouteOverrides).toBeUndefined()
        expect((await app.inject({ method: 'GET', url: '/cm/above-host' })).statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })

    it('required + above-host pack: ExtensionRequiredError (capability_mismatch)', async () => {
      Object.assign(env, { VAULT_EXTENSIONS_REQUIRED: true })
      const error = await bootFailure(ABOVE_HOST)
      expect(error).toBeInstanceOf(ExtensionRequiredError)
      expect(error).toMatchObject({
        reason: 'extension_required_load_failed',
        loadFailureReason: 'capability_mismatch',
      })
    })

    it('required + the rollback escape: a same-major above-host pack still loads', async () => {
      Object.assign(env, {
        VAULT_EXTENSIONS_REQUIRED: true,
        VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST: true,
      })
      const app = await boot(ABOVE_HOST)
      try {
        expect(getExtensionStatus().status).toBe('loaded')
        expect((await app.inject({ method: 'GET', url: '/cm/above-host' })).statusCode).toBe(401)
      } finally {
        await app.close()
      }
    })

    it('required + a package that cannot be imported: ExtensionRequiredError (import_error)', async () => {
      Object.assign(env, {
        VAULT_EXTENSIONS_REQUIRED: true,
        VAULT_EXTENSIONS_PACKAGE: '@project-vault/does-not-exist-68-8',
      })
      const error = await bootFailure('default')
      expect(error).toMatchObject({
        reason: 'extension_required_load_failed',
        loadFailureReason: 'import_error',
      })
    })

    it('required with no package configured: ExtensionRequiredError (extension_required_not_configured)', async () => {
      Object.assign(env, { VAULT_EXTENSIONS_REQUIRED: true, VAULT_EXTENSIONS_PACKAGE: undefined })
      const error = await bootFailure('default')
      expect(error).toMatchObject({ reason: 'extension_required_not_configured' })
    })

    it('required + a valid pack boots with the extension loaded', async () => {
      Object.assign(env, { VAULT_EXTENSIONS_REQUIRED: true })
      const app = await boot('default')
      try {
        expect(getExtensionStatus().status).toBe('loaded')
      } finally {
        await app.close()
      }
    })
  })

  describe('AC-6 — replaceSecurity is never refused', () => {
    it('on a native-credential route and a platform-operator route: boots, applies and records both', async () => {
      const app = await boot('never-refused')
      try {
        const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })
        expect(login.json()).toEqual({ cm: true })
        const settings = await app.inject({ method: 'GET', url: '/api/v1/admin/settings' })
        expect(settings.json()).toEqual({ cm: true })
        const recorded = apiRoutesStatus(app.pvApiRouteOverrides).overrides
        expect(
          recorded.map((entry) => [entry.method, entry.url, entry.replaceSecurity, entry.target])
        ).toEqual([
          ['GET', '/api/v1/admin/settings', true, 'secureRoute'],
          ['POST', '/api/v1/auth/login', true, 'raw'],
        ])
      } finally {
        await app.close()
      }
    })
  })

  describe('AC-1 edge — an old pack without apiRoutes', () => {
    it('loads exactly as before: no apiRoutes log line, empty status, no table', async () => {
      const logs = createLogCaptureStream()
      const app = await boot('old-pack', { level: 'info', stream: logs.stream })
      try {
        expect(getExtensionStatus().status).toBe('loaded')
        expect(app.pvApiRouteOverrides).toBeUndefined()
        expect(apiRoutesStatus(app.pvApiRouteOverrides)).toEqual({
          added: [],
          overrides: [],
          app: { errorHandler: null, notFoundHandler: null, hooks: { prepend: [], append: [] } },
        })
        const events = parseCapturedLogLines(logs.lines).map((line) => String(line['eventType']))
        expect(events.filter((event) => event.startsWith('extension.api_route'))).toEqual([])
      } finally {
        await app.close()
      }
    })
  })

  describe('AC-10 / AC-18 / AC-19 — registration order and tripwires', () => {
    it('the add plugin is the last route registration', async () => {
      const app = await boot('default')
      try {
        const order = [...app.pvRouteIndex]
        const firstAdded = order.findIndex(
          (key) => key.startsWith('GET /api/v1/cm/') || key.startsWith('POST /cm/')
        )
        expect(firstAdded).toBeGreaterThan(0)
        const added = new Set(
          apiRoutesStatus(app.pvApiRouteOverrides).added.flatMap((entry) => [
            `${entry.method} ${entry.url}`,
            `HEAD ${entry.url}`,
          ])
        )
        for (const key of order.slice(firstAdded)) expect(added.has(key)).toBe(true)
      } finally {
        await app.close()
      }
    })

    it('no extension: no two distinct PV routes share a default rate-limit bucket or a default audit eventType', async () => {
      Object.assign(env, { VAULT_EXTENSIONS_PACKAGE: undefined })
      const app = await boot('default')
      try {
        const registrations = [...app.pvSecureRouteRegistry.values()]
        expect(registrations.length).toBeGreaterThan(150)
        const defaultKeys = registrations
          .filter((entry) => entry.rateLimitKeyIsDefault)
          .map((entry) => entry.rateLimitKey)
        expect(new Set(defaultKeys).size).toBe(defaultKeys.length)
        const effectiveKeys = registrations
          .map((entry) => entry.rateLimitKey)
          .filter((key): key is string => key !== null)
        const defaultKeySet = new Set(defaultKeys)
        // A default key never collides with another route's explicit key either.
        for (const entry of registrations.filter((candidate) => !candidate.rateLimitKeyIsDefault)) {
          if (entry.rateLimitKey !== null) expect(defaultKeySet.has(entry.rateLimitKey)).toBe(false)
        }
        expect(effectiveKeys.length).toBeGreaterThan(0)
        const defaultEventTypes = registrations
          .map((entry) => entry.defaultAuditEventType)
          .filter((eventType): eventType is string => eventType !== null)
        expect(new Set(defaultEventTypes).size).toBe(defaultEventTypes.length)
        expect(app.pvApiRouteOverrides).toBeUndefined()
      } finally {
        await app.close()
      }
    })
  })

  describe('AC-14 — a raw-route override and the vault guard while sealed', () => {
    it('POST /api/v1/vault/unseal answers from CM; non-exempt paths are still sealed', async () => {
      await resetVaultForTest()
      const app = await boot('default')
      try {
        const unseal = await app.inject({
          method: 'POST',
          url: '/api/v1/vault/unseal',
          payload: {},
        })
        expect(unseal.json()).toEqual({ cm: 'unseal' })
        const docs = await app.inject({ method: 'GET', url: '/api/v1/cm/documents' })
        expect(docs.statusCode).toBe(503)
        expect(docs.json()).toMatchObject({ status: 'sealed' })
      } finally {
        await app.close()
        await initVaultForTest(initVault, PASSPHRASE)
      }
    })
  })
})
