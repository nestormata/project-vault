import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  API_ROUTES_FIXTURE_PACKAGE,
  importApiRoutesFixture,
} from '../__tests__/helpers/api-routes-fixture.js'
import { prepareSpecGenerationEnv } from './spec-env.js'

/**
 * Story 68.14 AC-2 — the runtime route audit against the REAL `createApp()`: a no-extension run, a
 * run with the fixture extension loaded (DB-free through the loader seams), a mutated
 * classification table, the classification input errors and the CLI's exit codes.
 */
prepareSpecGenerationEnv(process.env)
process.env['ENABLE_API_DOCS'] = 'true'

const { createApp } = await import('../app.js')
const { getExtensionStatus, __resetExtensionStateForTests } =
  await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const { PUBLIC_ROUTE_EXEMPTIONS } = await import('../lib/route-exemptions.js')
const {
  AuditLoadError,
  parseAuditArgs,
  pvClassifications,
  runCli,
  runRouteAudit,
  AuditUsageError,
} = await import('./runtime-route-audit.js')
const fixture = await importApiRoutesFixture()

const HEALTH_ROUTE = 'GET /health'
const EXTENSION_FLAG = '--extension'
const BARE_ERROR = 'bare package specifier'
const NEEDS_VALUE = 'needs a value'
const CLASSIFICATIONS_FLAG = '--classifications'
const MISSING_PACKAGE = '@nope/missing-68-14'
const CLI_FILE = 'src/scripts/runtime-route-audit.ts'
const STALE_ROUTE = 'GET /cm/not-there'
const fixturePath = (name: string): string =>
  fileURLToPath(
    new URL(`../extensions/api-routes/__fixtures__/classifications/${name}`, import.meta.url)
  )
const apiDir = new URL('../../', import.meta.url).pathname

function resetWorld(): void {
  __resetExtensionStateForTests()
  __resetCapabilityGateForTests()
  __resetAuthStrategiesForTests()
  fixture.resetObserved()
  fixture.setApiRoutesScenario('default')
}

function deps() {
  const injected = vi.fn()
  return {
    injected,
    deps: {
      getExtensionStatus,
      createApp: async (options: Parameters<typeof createApp>[0]) => {
        const app = await createApp(options)
        const original = app.inject.bind(app)
        app.inject = ((...args: Parameters<typeof original>) => {
          injected()
          return original(...args)
        }) as typeof app.inject
        return app
      },
    },
  }
}

describe('runtime route audit (Story 68.14 AC-2)', () => {
  beforeAll(resetWorld)
  afterEach(resetWorld)

  it('no extension: passes, every route is counted exactly once and no request is sent', async () => {
    const { deps: auditDeps, injected } = deps()
    const report = await runRouteAudit({}, auditDeps)
    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.total).toBeGreaterThan(300)
    expect(Object.values(report.counts).reduce((sum, count) => sum + count, 0)).toBe(report.total)
    expect(report.counts.secureRoute).toBeGreaterThan(200)
    expect(report.counts['classified-extension']).toBe(0)
    expect(report.counts['head-clone']).toBeGreaterThan(0)
    expect(injected).not.toHaveBeenCalled()
  })

  it('fixture extension loaded (DB-free): passes and counts the extension-added routes as secureRoute-built', async () => {
    const baseline = await runRouteAudit({}, deps().deps)
    resetWorld()
    const { deps: auditDeps, injected } = deps()
    const report = await runRouteAudit({ extension: API_ROUTES_FIXTURE_PACKAGE }, auditDeps)
    expect(report.failures).toEqual([])
    expect(getExtensionStatus().status).toBe('loaded')
    // 8 added routes plus 6 GET HEAD clones: extension routes need no classification.
    expect(report.counts.secureRoute).toBeGreaterThan(baseline.counts.secureRoute)
    expect(report.total).toBeGreaterThan(baseline.total)
    expect(injected).not.toHaveBeenCalled()
  })

  it('removing GET /health from the table fails naming GET and HEAD /health', async () => {
    const pvEntries = pvClassifications().filter((entry) => entry.route !== HEALTH_ROUTE)
    expect(pvEntries).toHaveLength(pvClassifications().length - 1)
    const report = await runRouteAudit({}, { ...deps().deps, pvEntries })
    expect(report.ok).toBe(false)
    expect(report.failures.some((line) => line.includes('unclassified route GET /health'))).toBe(
      true
    )
    expect(report.failures.some((line) => line.includes('unclassified route HEAD /health'))).toBe(
      true
    )
  })

  it('a stale PV classification fails and names the key', async () => {
    const pvEntries = [...pvClassifications(), { route: 'GET /api/v1/never-existed', reason: 'r' }]
    const report = await runRouteAudit({}, { ...deps().deps, pvEntries })
    expect(report.failures).toEqual([
      'stale classification GET /api/v1/never-existed: no such route',
    ])
  })

  it('an extension classification file is merged and a stale entry in it fails', async () => {
    const report = await runRouteAudit(
      { extension: API_ROUTES_FIXTURE_PACKAGE, classifications: fixturePath('stale.json') },
      deps().deps
    )
    expect(report.failures).toEqual([`stale classification ${STALE_ROUTE}: no such route`])
  })

  it('an extension that does not load fails the audit with the loader reason', async () => {
    await expect(runRouteAudit({ extension: MISSING_PACKAGE }, deps().deps)).rejects.toThrow(
      AuditLoadError
    )
    resetWorld()
    await expect(runRouteAudit({ extension: MISSING_PACKAGE }, deps().deps)).rejects.toThrow(
      'did not load: import_error'
    )
  })

  it('PV table entries all have a non-empty reason and a unique key', () => {
    const entries = pvClassifications()
    expect(new Set(entries.map((entry) => entry.route)).size).toBe(entries.length)
    expect(entries.every((entry) => entry.reason.trim().length > 0)).toBe(true)
    expect(entries.length).toBeGreaterThanOrEqual(PUBLIC_ROUTE_EXEMPTIONS.length)
  })
})

describe('parseAuditArgs', () => {
  it('accepts both flags', () => {
    expect(parseAuditArgs([EXTENSION_FLAG, '@cm/pack', CLASSIFICATIONS_FLAG, 'a.json'])).toEqual({
      extension: '@cm/pack',
      classifications: 'a.json',
    })
    expect(parseAuditArgs([])).toEqual({ extension: undefined, classifications: undefined })
  })

  it.each([
    [['--nope'], 'unknown argument'],
    [[EXTENSION_FLAG], NEEDS_VALUE],
    [[EXTENSION_FLAG, ''], NEEDS_VALUE],
    [[EXTENSION_FLAG, CLASSIFICATIONS_FLAG], NEEDS_VALUE],
    [[EXTENSION_FLAG, 'a', EXTENSION_FLAG, 'b'], 'more than once'],
    [[EXTENSION_FLAG, './local'], BARE_ERROR],
    [[EXTENSION_FLAG, '/abs/path'], BARE_ERROR],
    [[EXTENSION_FLAG, 'https://x.test/p'], BARE_ERROR],
    [[EXTENSION_FLAG, '../up'], BARE_ERROR],
    [[EXTENSION_FLAG, 'file:pkg'], BARE_ERROR],
    [[EXTENSION_FLAG, '@scope'], BARE_ERROR],
  ])('rejects %j', (argv, message) => {
    expect(() => parseAuditArgs(argv)).toThrow(AuditUsageError)
    expect(() => parseAuditArgs(argv)).toThrow(message)
  })
})

describe('runCli exit codes', () => {
  beforeAll(resetWorld)
  afterEach(resetWorld)

  const capture = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    }
  }

  it('0 with a summary for a passing run', async () => {
    const { out, err, io } = capture()
    expect(await runCli([], deps().deps, io)).toBe(0)
    expect(out.join('')).toContain('route audit: PASS')
    expect(err).toEqual([])
  })

  it('1 and the failing keys for a failing run', async () => {
    const pvEntries = pvClassifications().filter((entry) => entry.route !== HEALTH_ROUTE)
    const { out, io } = capture()
    expect(await runCli([], { ...deps().deps, pvEntries }, io)).toBe(1)
    expect(out.join('')).toContain('unclassified route GET /health')
  })

  it('2 for usage and classification input errors, never a silent drop', async () => {
    const usage = capture()
    expect(await runCli(['--bogus'], deps().deps, usage.io)).toBe(2)
    expect(usage.err.join('')).toContain('usage: route-audit:runtime')
    const bad = capture()
    expect(
      await runCli([CLASSIFICATIONS_FLAG, fixturePath('missing-reason.json')], deps().deps, bad.io)
    ).toBe(2)
    expect(bad.err.join('')).toContain('classifications[0].reason must be a non-empty string')
    const missing = capture()
    expect(
      await runCli([CLASSIFICATIONS_FLAG, fixturePath('absent.json')], deps().deps, missing.io)
    ).toBe(2)
  })

  it('1 when the extension does not load', async () => {
    const { err, io } = capture()
    expect(await runCli([EXTENSION_FLAG, MISSING_PACKAGE], deps().deps, io)).toBe(1)
    expect(err.join('')).toContain('did not load')
  })
})

describe('the CLI process', () => {
  it('exits 2 on a usage error before booting anything', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', CLI_FILE, '--bogus'], {
      cwd: apiDir,
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown argument "--bogus"')
    expect(result.stdout).toBe('')
  })

  it('exits 0 with a deterministic summary and no absolute path or env value', () => {
    const run = () =>
      execFileSync('pnpm', ['exec', 'tsx', CLI_FILE], {
        cwd: apiDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          VAULT_EXTENSIONS_PACKAGE: API_ROUTES_FIXTURE_PACKAGE,
          VAULT_EXTENSIONS_REQUIRED: 'true',
        },
      })
    const first = run()
    expect(first).toContain('route audit: PASS')
    expect(first).not.toContain(process.cwd())
    expect(first).not.toContain(API_ROUTES_FIXTURE_PACKAGE)
    expect(run()).toBe(first)
  }, 120_000)
})
