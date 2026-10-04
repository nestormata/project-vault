import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import { sha256Hex } from '../src/hash.js'
import { runVerifyCli } from '../src/verify-cli.js'
import { acquireRunLock, extractClassifications, findVitestConfig, verify } from '../src/verify.js'
import {
  makeWorld,
  manifest,
  sha,
  shaOf,
  useWorlds,
  writeAll,
  type World,
} from './compose-test-helpers.js'
import type { UiPackManifest } from '../src/types.js'

useWorlds()

const GUARD_FILE = 'src/lib/security/mini.test.ts'
const HELPER_FILE = 'src/lib/test/mini-helper.ts'
const SCRIPT_FILE = 'guards/mini.js'
const MJS_CONFIG = 'vitest.config.mjs'
const TS_CONFIG = 'vitest.config.ts'
const CALLER_VALUE = '/caller-value'
const GENERATED_CONFIG = 'verify.vitest.config.mjs'
const EMPTY_CONFIG = 'export default {}\n'
const BAD_TOKEN = 'FORBIDDEN_TOKEN'
const LICENSE = 'AGPL-3.0-or-later'
const LOCK_FILE = 'composition.lock.json'
const UTIL = 'src/lib/util.ts'
const UTIL_TEST = 'src/lib/util.test.ts'
const OVERRIDE_BODY = 'export const fmt = String\n'
const OTHER_TEST = 'src/lib/other.test.ts'

// A plain-TypeScript guard: fails when any file under the app root's src holds the token.
const GUARD = `/** @pv-guard mini */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appRoot } from '../test/mini-helper.js'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('mini guard', () => {
  it('no source file holds the forbidden token', () => {
    const bad = files(join(appRoot(), 'src')).filter((file) => readFileSync(file, 'utf8').includes('${BAD_TOKEN.slice(0, 6)}' + '${BAD_TOKEN.slice(6)}'))
    expect(bad, bad.join('; ')).toEqual([])
  })
})
`
const HELPER = "export const appRoot = (): string => process.env.PV_GUARD_APP_ROOT ?? ''\n"
const SCRIPT = `export function runGuard(appRoot) {
  return appRoot.includes('never-matches-this') ? [{ file: 'x', message: 'script finding' }] : []
}
`
const FAKE_FACTORY = `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDefaults } from 'vitest/config'
export function vitestConfig(overrides, options) {
  const lock = JSON.parse(readFileSync(join(options.composedRoot, 'composition.lock.json'), 'utf8'))
  return { test: { include: ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, ...lock.excludedPvTests] } }
}
`

function registry(extra: object[] = []): string {
  return JSON.stringify({
    schemaVersion: 1,
    guards: [
      {
        id: 'mini',
        kind: 'test',
        file: GUARD_FILE,
        scope: 'all-files',
        license: LICENSE,
        closure: [{ file: HELPER_FILE, sha256: sha256Hex(Buffer.from(HELPER)) }],
      },
      {
        id: 'mini-script',
        kind: 'script',
        file: SCRIPT_FILE,
        scope: 'all-files',
        license: LICENSE,
        closure: [],
      },
      ...extra,
    ],
  })
}

const vitestPackage = dirname(createRequire(import.meta.url).resolve('vitest/package.json'))

interface Setup {
  hostFiles?: Record<string, string | null>
  packFiles?: Record<string, string>
  appTests?: Record<string, string>
  subjects?: Record<string, string[]>
  manifest?: (world: World) => Partial<UiPackManifest>
  /** The app's own Vitest/Vite config files (name -> body). Default: one `vitest.config.mjs`; `{}` = none. */
  appConfig?: Record<string, string>
}

// The app's own config, as a CM-style app writes it: the web-host factory plus the composed root.
const appConfigBody = (appRoot: string): string =>
  `import { vitestConfig } from '@project-vault/web-host/vitest.config'
export default vitestConfig({}, { composedRoot: ${JSON.stringify(appRoot)} })
`

async function composedWorld(setup: Setup = {}): Promise<World> {
  const world = makeWorld({
    hostFiles: {
      'manifests/guards.json': registry(),
      [GUARD_FILE]: GUARD,
      [HELPER_FILE]: HELPER,
      [SCRIPT_FILE]: SCRIPT,
      ...(setup.subjects === undefined
        ? {}
        : {
            'manifests/test-subjects.json': JSON.stringify({
              schemaVersion: 1,
              subjects: setup.subjects,
            }),
          }),
      ...setup.hostFiles,
    },
    packFiles: setup.packFiles ?? {},
  })
  const result = await compose({
    appRoot: world.app,
    packRoot: world.pack,
    hostDir: world.host,
    manifest: manifest(setup.manifest?.(world) ?? {}),
  })
  expect(result.messages).toEqual([])
  mkdirSync(join(world.app, 'node_modules'), { recursive: true })
  symlinkSync(vitestPackage, join(world.app, 'node_modules', 'vitest'))
  writeAll(world.app, {
    'node_modules/@project-vault/web-host/package.json': JSON.stringify({
      name: '@project-vault/web-host',
      type: 'module',
      exports: { './vitest.config': './vitest.config.js' },
    }),
    'node_modules/@project-vault/web-host/vitest.config.js': FAKE_FACTORY,
    ...(setup.appConfig ?? { [MJS_CONFIG]: appConfigBody(world.app) }),
    ...setup.appTests,
  })
  return world
}

const options = (world: World) => ({ appRoot: world.app, hostDir: world.host })

describe('pv-verify (Story 68.9 AC-9)', () => {
  it('passes a clean composed tree and reports counts', async () => {
    const world = await composedWorld({
      appTests: {
        'src/lib/ok.test.ts':
          "import { it, expect } from 'vitest'\nit('ok', () => expect(1).toBe(1))\n",
      },
    })
    const report = await verify(options(world))
    expect(report.preflight).toEqual({ ok: true, problems: [], regenerated: false })
    expect(report.guards?.outcomes.map((o) => [o.id, o.ok])).toEqual([
      ['mini', true],
      ['mini-script', true],
    ])
    expect(report.guards?.skipped).toEqual([
      'injection-point-coverage: skipped (not published by this web-host)',
      'monolithic-region: skipped (not published by this web-host)',
    ])
    // the shipped guard test file is part of the composed tree and runs in the tests step too
    expect(report.tests?.run).toBe(2)
    expect(report.ok).toBe(true)
  })

  it("hands the lock's CM-originated files to a pv-originated-only script guard and to no other", async () => {
    const reporter = `export function runGuard(root, exempt) {
  return [{ file: 'x', message: 'exempt=' + JSON.stringify(exempt ?? null) }]
}
`
    const entry = (id: string, file: string, scope: string) => ({
      id,
      kind: 'script',
      file,
      scope,
      license: LICENSE,
      closure: [],
    })
    const world = await composedWorld({
      packFiles: { 'src/lib/billing/ok.ts': 'export const ok = 1\n' },
      hostFiles: {
        'manifests/guards.json': registry([
          entry('scoped-script', 'guards/scoped.js', 'pv-originated-only'),
          entry('open-script', 'guards/open.js', 'all-files'),
        ]),
        'guards/scoped.js': reporter,
        'guards/open.js': reporter,
      },
    })
    const report = await verify(options(world))
    const failures = (id: string) => report.guards?.outcomes.find((o) => o.id === id)?.failures
    expect(failures('scoped-script')).toEqual(['exempt=["src/lib/billing/ok.ts"]'])
    expect(failures('open-script')).toEqual(['exempt=[]'])
  })

  it('names the file and rule of a CM file that breaks a guard, without stopping the tests step', async () => {
    const world = await composedWorld({
      packFiles: { 'src/lib/billing/bad.ts': `export const x = '${BAD_TOKEN}'\n` },
      appTests: {
        'src/lib/fails.test.ts':
          "import { it, expect } from 'vitest'\nit('fails', () => expect(1).toBe(2))\n",
      },
    })
    const report = await verify(options(world))
    expect(report.ok).toBe(false)
    const mini = report.guards?.outcomes.find((o) => o.id === 'mini')
    expect(mini?.ok).toBe(false)
    expect(mini?.failures.join('\n')).toContain('bad.ts')
    // one pass reports every finding: the failing test is reported too
    // the composed copy of the guard test fails in the tests step too
    expect(report.tests?.failed).toBe(2)
    expect(report.tests?.failures.join('\n')).toContain('fails')
  })

  it('does not run an excluded PV test and lists it in the report', async () => {
    const failing =
      "import { it, expect } from 'vitest'\nit('would fail', () => expect(1).toBe(2))\n"
    const world = await composedWorld({
      subjects: { [UTIL_TEST]: [UTIL] },
      hostFiles: { [UTIL_TEST]: failing },
      packFiles: { [UTIL]: OVERRIDE_BODY },
      manifest: (made) => ({
        routes: {
          overrides: [{ path: UTIL, hostSha256: sha(made, UTIL) }],
        },
      }),
    })
    const report = await verify(options(world))
    expect(report.tests?.excluded).toEqual([UTIL_TEST])
    expect(report.tests?.run).toBe(1)
    expect(report.tests?.failed).toBe(0)
  })

  describe('lock consistency without --pack (DW-495)', () => {
    const subjects = { [UTIL_TEST]: [UTIL], [OTHER_TEST]: ['src/lib/other.ts'] }
    const overridden = (): Setup => ({
      subjects,
      packFiles: { [UTIL]: OVERRIDE_BODY },
      manifest: (made) => ({
        routes: { overrides: [{ path: UTIL, hostSha256: sha(made, UTIL) }] },
      }),
    })
    const edit = (world: World, change: (lock: Record<string, unknown>) => void): void => {
      const path = join(world.app, LOCK_FILE)
      const lock = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      change(lock)
      writeFileSync(path, JSON.stringify(lock))
    }

    it('passes a clean lock, for an override and for a replacement', async () => {
      const world = await composedWorld(overridden())
      expect((await verify({ ...options(world), only: 'guards' })).preflight.problems).toEqual([])
      const replaced = await composedWorld({
        subjects,
        packFiles: { 'repl/util.ts': OVERRIDE_BODY },
        manifest: (made) => ({
          replacements: {
            '$lib/util.ts': { with: './repl/util.ts', hostSha256: sha(made, UTIL) },
          },
        }),
      })
      const lock = JSON.parse(readFileSync(join(replaced.app, LOCK_FILE), 'utf8')) as {
        excludedPvTests: string[]
      }
      expect(lock.excludedPvTests).toEqual([UTIL_TEST])
      expect((await verify({ ...options(replaced), only: 'guards' })).preflight.problems).toEqual(
        []
      )
    })

    it('fails closed on a hand-edited list, naming the extra and the missing test', async () => {
      const world = await composedWorld(overridden())
      edit(world, (lock) => {
        lock.excludedPvTests = [OTHER_TEST]
      })
      const report = await verify({ ...options(world), only: 'guards' })
      expect(report.ok).toBe(false)
      const [problem] = report.preflight.problems
      expect(problem).toContain('excludedPvTests')
      expect(problem).toContain(`extra: ${OTHER_TEST}`)
      expect(problem).toContain(`missing: ${UTIL_TEST}`)
      expect(problem).toContain('re-run pv-compose')
    })

    it('treats an old lock without the list as empty, so a lock that implies exclusions fails', async () => {
      const world = await composedWorld(overridden())
      edit(world, (lock) => {
        delete lock.excludedPvTests
      })
      const [problem] = (await verify({ ...options(world), only: 'guards' })).preflight.problems
      expect(problem).toContain(`missing: ${UTIL_TEST}`)
    })

    it('checks nothing it cannot recompute: a host without a subject map', async () => {
      const world = await composedWorld({ hostFiles: { 'manifests/test-subjects.json': null } })
      expect((await verify({ ...options(world), only: 'guards' })).preflight.problems).toEqual([])
    })
  })

  it('runs the pristine host guard when the pack overrode its helper (a helper cannot blind a guard)', async () => {
    const blinded = "export const appRoot = (): string => '/nowhere'\n"
    const world = await composedWorld()
    writeFileSync(join(world.app, HELPER_FILE), blinded)
    writeFileSync(join(world.app, 'src/lib/bad.ts'), `export const x = '${BAD_TOKEN}'\n`)
    const report = await verify(options(world))
    expect(report.guards?.overridden).toEqual([HELPER_FILE])
    expect(report.guards?.outcomes.find((o) => o.id === 'mini')?.ok).toBe(false)
    expect(report.warnings).toContain(
      `guard-file-overridden ${HELPER_FILE} (the pristine PV copy ran)`
    )
  })

  it('reports a removed guard file as overridden and still runs the host copy', async () => {
    const world = await composedWorld()
    writeFileSync(join(world.app, 'src/lib/bad.ts'), `export const x = '${BAD_TOKEN}'\n`)
    writeAll(world.app, {})
    const { rmSync } = await import('node:fs')
    rmSync(join(world.app, GUARD_FILE))
    const report = await verify({ ...options(world), only: 'guards' })
    expect(report.guards?.overridden).toContain(GUARD_FILE)
    expect(report.ok).toBe(false)
  })

  it('stages a guard subject from the COMPOSED app, so a pack override of it is what the guard sees', async () => {
    const subject = 'src/lib/subject.ts'
    const subjectGuard = 'src/lib/security/subject.test.ts'
    const guardSource = `/** @pv-guard subject */
import { expect, it } from 'vitest'
import { value } from '../subject.js'
it('the subject answers pv', () => expect(value).toBe('pv'))
`
    const hostSubject = "export const value = 'pv'\n"
    const subjectEntry = {
      id: 'subject',
      kind: 'test',
      file: subjectGuard,
      scope: 'all-files',
      license: LICENSE,
      closure: [],
      subjects: [subject],
      subjectClosure: [],
    }
    const setup = (override: boolean): Setup => ({
      hostFiles: {
        'manifests/guards.json': registry([subjectEntry]),
        [subjectGuard]: guardSource,
        [subject]: hostSubject,
      },
      ...(override
        ? {
            packFiles: { [subject]: "export const value = 'cm'\n" },
            manifest: () => ({
              routes: { overrides: [{ path: subject, hostSha256: shaOf(hostSubject) }] },
            }),
          }
        : {}),
    })
    const clean = await verify({ ...options(await composedWorld(setup(false))), only: 'guards' })
    expect(clean.guards?.outcomes.find((o) => o.id === 'subject')?.ok).toBe(true)
    const overridden = await verify({
      ...options(await composedWorld(setup(true))),
      only: 'guards',
    })
    const outcome = overridden.guards?.outcomes.find((o) => o.id === 'subject')
    expect(outcome?.ok).toBe(false)
    expect(outcome?.failures.join('\n')).toContain("expected 'cm' to be 'pv'")
    // the guard file itself is the pristine host copy: only the subject differs
    expect(overridden.guards?.overridden).not.toContain(subjectGuard)
  })

  it('fails (never skips) when the host publishes no guard registry', async () => {
    const world = await composedWorld({ hostFiles: { 'manifests/guards.json': null } })
    const report = await verify(options(world))
    expect(report.ok).toBe(false)
    expect(report.guards?.problems[0]).toContain('does not publish its guard registry')
  })

  it('fails on a stale or missing lock before running anything', async () => {
    const world = await composedWorld()
    writeFileSync(join(world.app, LOCK_FILE), '{}')
    const stale = await verify(options(world))
    expect(stale.ok).toBe(false)
    expect(stale.guards).toBeUndefined()
    const none = makeWorld()
    expect((await verify(options(none))).preflight.problems[0]).toContain(
      'no committed composition.lock.json'
    )
  })

  it('fails on a lock written against another PV release', async () => {
    const world = await composedWorld()
    const lock = JSON.parse(readFileSync(join(world.app, LOCK_FILE), 'utf8')) as {
      compatibility: { pvRelease: string }
    }
    lock.compatibility.pvRelease = '0.0.1'
    writeFileSync(join(world.app, LOCK_FILE), JSON.stringify(lock))
    const report = await verify(options(world))
    expect(report.preflight.problems[0]).toContain(
      'composition.lock.json is out of date, run pv-compose'
    )
  })

  it('fails on a hand-edited generated guard entries module', async () => {
    const world = await composedWorld({
      hostFiles: {
        'src/lib/composition/guard-entries.generated.json': JSON.stringify({
          _generated: 'x',
          browserStorage: {},
        }),
      },
    })
    expect((await verify(options(world))).preflight.problems).toEqual([])
    writeFileSync(
      join(world.app, 'src/lib/composition/guard-entries.generated.json'),
      JSON.stringify({ _generated: 'x', browserStorage: { release: ['src/x.ts'] } })
    )
    const report = await verify(options(world))
    expect(report.preflight.problems[0]).toContain(
      'generated guard entries differ from composition.lock.json (browserStorage)'
    )
  })

  it('fails when the lock records no guard entries but the app holds a generated module', async () => {
    const world = await composedWorld({
      hostFiles: {
        'src/lib/composition/guard-entries.generated.json': JSON.stringify({
          _generated: 'x',
          browserStorage: {},
        }),
      },
    })
    const lockPath = join(world.app, LOCK_FILE)
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
    delete lock.guardEntries
    writeFileSync(lockPath, JSON.stringify(lock))
    const report = await verify(options(world))
    expect(report.preflight.problems.join('\n')).toContain('differ from composition.lock.json')
  })

  it('never leaks the guards scan root to the caller or to the tests step', async () => {
    const world = await composedWorld({
      appTests: {
        'src/lib/env.test.ts':
          "import { it, expect } from 'vitest'\nit('guard root is not visible to CM tests', () => {\n  expect(process.env.PV_GUARD_APP_ROOT).toBeUndefined()\n})\n",
      },
    })
    process.env.PV_GUARD_APP_ROOT = CALLER_VALUE
    try {
      const report = await verify(options(world))
      expect(report.tests?.failures).toEqual([])
      expect(report.tests?.ok).toBe(true)
      expect(process.env.PV_GUARD_APP_ROOT).toBe(CALLER_VALUE)
    } finally {
      delete process.env.PV_GUARD_APP_ROOT
    }
  })

  describe("the app's own Vitest config (Story 68-21)", () => {
    const PLUGIN_TEST =
      "import { it, expect } from 'vitest'\nimport { v } from 'virtual:app-only'\nit('sees the plugin', () => expect(v).toBe(42))\n"
    // A module only a plugin registered by the app's own config can resolve (stands in for pvHooks()).
    const pluginConfig = (
      appRoot: string
    ): string => `import { vitestConfig } from '@project-vault/web-host/vitest.config'
const appOnly = {
  name: 'app-only',
  resolveId: (id) => (id === 'virtual:app-only' ? '\\0virtual:app-only' : null),
  load: (id) => (id === '\\0virtual:app-only' ? 'export const v = 42' : null),
}
export default { ...vitestConfig({}, { composedRoot: ${JSON.stringify(appRoot)} }), plugins: [appOnly] }
`
    const overriddenUtil = (): Setup => ({
      subjects: { [UTIL_TEST]: [UTIL] },
      packFiles: { [UTIL]: OVERRIDE_BODY },
      manifest: (made) => ({
        routes: { overrides: [{ path: UTIL, hostSha256: sha(made, UTIL) }] },
      }),
    })

    it("runs tests that need a plugin only the app's config registers, and writes no scratch config", async () => {
      const world = await composedWorld({
        appTests: { 'src/lib/plugin.test.ts': PLUGIN_TEST },
        appConfig: {},
      })
      writeFileSync(join(world.app, MJS_CONFIG), pluginConfig(world.app))
      const report = await verify({ ...options(world), only: 'tests' })
      expect(report.tests?.failures).toEqual([])
      expect(report.tests?.ok).toBe(true)
      expect(report.tests?.config).toBe(MJS_CONFIG)
      expect(existsSync(join(world.app, SCRATCH_DIR, GENERATED_CONFIG))).toBe(false)
    })

    it('fails loudly, spawning nothing, when the app has no vitest or vite config; consistency problems still show', async () => {
      const world = await composedWorld({
        ...overriddenUtil(),
        appConfig: { 'config/vitest.config.ts': EMPTY_CONFIG },
      })
      const lockPath = join(world.app, LOCK_FILE)
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
      lock.excludedPvTests = []
      writeFileSync(lockPath, JSON.stringify(lock))
      const report = await verify({ ...options(world), only: 'tests' })
      expect(report.ok).toBe(false)
      expect(report.tests?.ok).toBe(false)
      expect(report.tests?.problems).toEqual([
        `no vitest.config.* or vite.config.* in ${world.app}; pv-verify runs your tests with your own config so they see the same kit plugins as the build`,
      ])
      expect(report.preflight.problems.join('\n')).toContain('excludedPvTests')
      expect(existsSync(join(world.app, SCRATCH_DIR, 'verify-tests.json'))).toBe(false)
      expect(existsSync(join(world.app, SCRATCH_DIR, GENERATED_CONFIG))).toBe(false)
    })

    it('picks vitest.config.* over vite.config.*, in the order ts, mts, cts, js, mjs, cjs', async () => {
      const world = await composedWorld({ appConfig: {} })
      const found = () => findVitestConfig(world.app)
      expect(found()).toBeNull()
      writeAll(world.app, { 'vite.config.ts': EMPTY_CONFIG })
      expect(found()).toBe('vite.config.ts')
      writeAll(world.app, { 'vitest.config.cjs': 'module.exports = {}\n' })
      expect(found()).toBe('vitest.config.cjs')
      writeAll(world.app, { [MJS_CONFIG]: EMPTY_CONFIG })
      expect(found()).toBe(MJS_CONFIG)
      writeAll(world.app, { 'vitest.config.js': EMPTY_CONFIG })
      expect(found()).toBe('vitest.config.js')
      writeAll(world.app, { [TS_CONFIG]: EMPTY_CONFIG })
      expect(found()).toBe(TS_CONFIG)
    })

    it('runs the config the order picks when several exist, and names it', async () => {
      const world = await composedWorld({
        appConfig: { [MJS_CONFIG]: 'throw new Error("must not be loaded")\n' },
      })
      writeFileSync(join(world.app, TS_CONFIG), appConfigBody(world.app))
      const report = await verify({ ...options(world), only: 'tests' })
      expect(report.tests?.ok).toBe(true)
      expect(report.tests?.config).toBe(TS_CONFIG)
    })

    it('hints when a failing test is listed in excludedPvTests (the config did not apply the lock)', async () => {
      const failing =
        "import { it, expect } from 'vitest'\nit('would fail', () => expect(1).toBe(2))\n"
      const world = await composedWorld({
        ...overriddenUtil(),
        hostFiles: { [UTIL_TEST]: failing },
        appConfig: {},
      })
      // a config that ignores the lock's exclusions
      writeFileSync(
        join(world.app, MJS_CONFIG),
        "export default { test: { include: ['src/**/*.test.ts'] } }\n"
      )
      const report = await verify({ ...options(world), only: 'tests' })
      expect(report.tests?.failures.join('\n')).toContain(UTIL_TEST)
      expect(report.tests?.problems).toContain(
        "failing test is listed in composition.lock.json excludedPvTests; the app's vitest config must apply the lock's exclusions (vitestConfig({}, { composedRoot }))"
      )
    })

    it('adds no hint when the failing test is not excluded', async () => {
      const world = await composedWorld({
        appTests: {
          'src/lib/fails.test.ts':
            "import { it, expect } from 'vitest'\nit('fails', () => expect(1).toBe(2))\n",
        },
      })
      const report = await verify({ ...options(world), only: 'tests' })
      expect(report.tests?.problems).toEqual([])
    })

    it("still strips the guards-only variables when the app's own config runs", async () => {
      const world = await composedWorld({
        appTests: {
          'src/lib/env2.test.ts':
            "import { it, expect } from 'vitest'\nit('no guard vars', () => {\n  expect(process.env.PV_GUARD_APP_ROOT).toBeUndefined()\n  expect(process.env.PV_GUARD_EXEMPT_FILES).toBeUndefined()\n})\n",
        },
      })
      process.env.PV_GUARD_APP_ROOT = CALLER_VALUE
      process.env.PV_GUARD_EXEMPT_FILES = '["x"]'
      try {
        const report = await verify({ ...options(world), only: 'tests' })
        expect(report.tests?.failures).toEqual([])
        expect(report.tests?.ok).toBe(true)
      } finally {
        delete process.env.PV_GUARD_APP_ROOT
        delete process.env.PV_GUARD_EXEMPT_FILES
      }
    })
  })

  it('runs one step with --only', async () => {
    const world = await composedWorld()
    const guardsOnly = await verify({ ...options(world), only: 'guards' })
    expect(guardsOnly.tests).toBeUndefined()
    const testsOnly = await verify({ ...options(world), only: 'tests' })
    expect(testsOnly.guards).toBeUndefined()
  })
})

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } }
}

const SCRATCH_DIR = '.pv-compose'
const WEBHOOK_REASON = 'signed webhook'
const CLASSIFICATIONS_PACK = {
  'pv-guards.json': JSON.stringify({
    routeClassifications: [
      { route: 'POST /api/v1/cm/hook', reason: WEBHOOK_REASON },
      { route: 'GET /api/v1/cm/health', reason: 'public liveness probe', temporary: false },
    ],
  }),
}
const classifiedWorld = (): Promise<World> =>
  composedWorld({
    packFiles: CLASSIFICATIONS_PACK,
    manifest: () => ({ guards: 'pv-guards.json' }),
  })
const GENERATED_ENTRIES = 'src/lib/composition/guard-entries.generated.json'

describe('pv-verify --only classifications (Story 68-16 AC-2)', () => {
  it('writes the merged entries as a sorted, deterministic JSON array and runs nothing else', async () => {
    const world = await classifiedWorld()
    const out = join(world.root, 'audit-classifications.json')
    const first = await extractClassifications({ ...options(world), out })
    expect(first).toEqual({ ok: true, entries: 2, problems: [] })
    const text = readFileSync(out, 'utf8')
    // entries are sorted by route; keys keep the generated file's canonical (sorted) order
    expect(text).toBe(
      `${JSON.stringify(
        [
          { reason: 'public liveness probe', route: 'GET /api/v1/cm/health', temporary: false },
          { reason: WEBHOOK_REASON, route: 'POST /api/v1/cm/hook' },
        ],
        null,
        2
      )}\n`
    )
    await extractClassifications({ ...options(world), out })
    expect(readFileSync(out, 'utf8')).toBe(text)
    expect(readdirSync(world.root).filter((name) => name.includes('.tmp'))).toEqual([])
    // no guards or tests ran: nothing was written under the verify scratch dir
    expect(existsSync(join(world.app, SCRATCH_DIR, GENERATED_CONFIG))).toBe(false)
  })

  it('writes [] when the pack has no classifications', async () => {
    const world = await composedWorld()
    const out = join(world.root, 'empty.json')
    expect(await extractClassifications({ ...options(world), out })).toEqual({
      ok: true,
      entries: 0,
      problems: [],
    })
    expect(readFileSync(out, 'utf8')).toBe('[]\n')
  })

  it('writes no file when the generated entries were tampered with', async () => {
    const world = await classifiedWorld()
    const path = join(world.app, GENERATED_ENTRIES)
    const generated = JSON.parse(readFileSync(path, 'utf8')) as {
      routeClassifications: unknown[]
    }
    generated.routeClassifications.push({ route: 'GET /api/v1/evil', reason: 'sneaked in' })
    writeFileSync(path, JSON.stringify(generated))
    const out = join(world.root, 'tampered.json')
    const result = await extractClassifications({ ...options(world), out })
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('routeClassifications')
    expect(existsSync(out)).toBe(false)
  })

  it('writes no file without a lock', async () => {
    const world = await classifiedWorld()
    rmSync(join(world.app, LOCK_FILE))
    const out = join(world.root, 'nolock.json')
    expect((await extractClassifications({ ...options(world), out })).ok).toBe(false)
    expect(existsSync(out)).toBe(false)
  })

  it('refuses a directory target and a missing parent directory, leaving nothing behind', async () => {
    const world = await classifiedWorld()
    const directory = await extractClassifications({ ...options(world), out: world.root })
    expect(directory.ok).toBe(false)
    expect(directory.problems[0]).toContain('is a directory')
    const missing = join(world.root, 'nope', 'x.json')
    const parent = await extractClassifications({ ...options(world), out: missing })
    expect(parent.ok).toBe(false)
    expect(parent.problems[0]).toContain('parent directory does not exist')
    expect(readdirSync(world.root).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('does not replace an existing file when the run fails', async () => {
    const world = await classifiedWorld()
    const out = join(world.root, 'keep.json')
    writeFileSync(out, 'old\n')
    rmSync(join(world.app, LOCK_FILE))
    await extractClassifications({ ...options(world), out })
    expect(readFileSync(out, 'utf8')).toBe('old\n')
  })
})

describe('pv-verify --only classifications: command line (Story 68-16 AC-2)', () => {
  const sink = io

  it('exits 2 naming --out when it is missing, and when --out is combined with another step', async () => {
    const missing = sink()
    expect(await runVerifyCli(['--only', 'classifications'], missing.io)).toBe(2)
    expect(missing.err.join('')).toContain('--out')
    for (const argv of [
      ['--out', 'x.json'],
      ['--only', 'guards', '--out', 'x.json'],
      ['--only', 'tests', '--out', 'x.json'],
    ]) {
      const other = sink()
      expect(await runVerifyCli(argv, other.io), argv.join(' ')).toBe(2)
      expect(other.err.join('')).toContain('--out')
    }
  })

  it('writes the file (0), prints the count and never echoes entries', async () => {
    const world = await classifiedWorld()
    const out = join(world.root, 'cli-out.json')
    const text = sink()
    const argv = ['--app', world.app, '--host', world.host, '--only', 'classifications']
    expect(await runVerifyCli([...argv, '--out', out], text.io)).toBe(0)
    expect(text.out.join('')).toContain('pv-verify: classifications: 2 entries written')
    expect(text.out.join('')).not.toContain(WEBHOOK_REASON)
    expect(existsSync(out)).toBe(true)
    const json = sink()
    expect(await runVerifyCli([...argv, '--out', out, '--json'], json.io)).toBe(0)
    expect(JSON.parse(json.out.join(''))).toEqual({ ok: true, entries: 2 })
  })

  it('exits 1 with the problem and writes nothing on a failing preflight or a directory target', async () => {
    const world = await classifiedWorld()
    const argv = ['--app', world.app, '--host', world.host, '--only', 'classifications']
    const dir = sink()
    expect(await runVerifyCli([...argv, '--out', world.root], dir.io)).toBe(1)
    expect(dir.out.join('') + dir.err.join('')).toContain('is a directory')
    rmSync(join(world.app, LOCK_FILE))
    const out = join(world.root, 'x.json')
    const failed = sink()
    expect(await runVerifyCli([...argv, '--out', out], failed.io)).toBe(1)
    expect(existsSync(out)).toBe(false)
  })

  it('documents --only classifications --out in the usage', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'verify-cli.ts'), 'utf8')
    const usage = /const USAGE = `([\s\S]*?)`/.exec(source)?.[1] ?? ''
    expect(usage).toContain('--only <step>      run one step: guards, tests or classifications')
    expect(usage).toContain('--out <file>')
  })
})

describe('pv-verify run lock (Story 68.9 AC-15 concurrency)', () => {
  it('fails fast on a second run on one app root and replaces a stale lock', () => {
    const world = makeWorld()
    const first = acquireRunLock(world.app)
    expect('release' in first).toBe(true)
    expect(acquireRunLock(world.app)).toEqual({ heldBy: process.pid })
    if ('release' in first) first.release()
    expect(existsSync(join(world.app, SCRATCH_DIR, 'verify.lock'))).toBe(false)
    writeFileSync(join(world.app, SCRATCH_DIR, 'verify.lock'), '2147483646')
    const replaced = acquireRunLock(world.app)
    expect('release' in replaced).toBe(true)
    if ('release' in replaced) replaced.release()
  })
})

describe('pv-verify command line (Story 68.9 AC-9, Q5)', () => {
  it('prints help (0) and rejects unknown flags and steps (2)', async () => {
    const sink = io()
    expect(await runVerifyCli(['--help'], sink.io)).toBe(0)
    expect(sink.out.join('')).toContain(
      'Exit codes: 0 success, 1 a guard, test or integrity failure, 2 a usage error.'
    )
    for (const argv of [
      ['--nope'],
      ['--only', 'foo'],
      ['--only', 'classifications'],
      ['--skip-guards'],
    ]) {
      const failing = io()
      expect(await runVerifyCli(argv, failing.io), argv.join(' ')).toBe(2)
    }
  })

  it('has no flag that skips, disables or ignores a step or a guard', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'verify-cli.ts'), 'utf8')
    const usage = /const USAGE = `([\s\S]*?)`/.exec(source)?.[1] ?? ''
    expect(usage).toContain('There is no flag that skips')
    const flags = [...usage.matchAll(/^\s+(--[a-z-]+)/gm)].map((match) => match[1])
    expect(flags).toEqual(['--app', '--host', '--pack', '--only', '--out', '--explain', '--json'])
    expect(flags.join(' ')).not.toMatch(/skip|disable|ignore|allow|exclude|force/)
  })

  it('exits 2 for a missing app directory and 1 for a failing run, printing text or JSON', async () => {
    const missing = io()
    expect(
      await runVerifyCli(['--app', '/definitely/not/here', '--host', '/nope'], missing.io)
    ).toBe(2)
    const world = await composedWorld({
      packFiles: { 'src/lib/bad.ts': `export const x = '${BAD_TOKEN}'\n` },
    })
    const text = io()
    expect(
      await runVerifyCli(['--app', world.app, '--host', world.host, '--only', 'guards'], text.io)
    ).toBe(1)
    expect(text.out.join('')).toContain('FAIL mini')
    const json = io()
    expect(
      await runVerifyCli(
        ['--app', world.app, '--host', world.host, '--only', 'guards', '--json'],
        json.io
      )
    ).toBe(1)
    const document = JSON.parse(json.out.join('')) as {
      ok: boolean
      guards: { outcomes: unknown[] }
    }
    expect(document.ok).toBe(false)
    expect(document.guards.outcomes).toHaveLength(2)
    expect(json.out.join('')).not.toContain(process.env.HOME ?? '\u0000never')
  })

  it('maps composed paths back to the pack source with --explain', async () => {
    const world = await composedWorld({
      packFiles: { 'brand/theme.css': `:root { --x: '${BAD_TOKEN}' }\n` },
      manifest: () => ({ theme: 'brand/theme.css' }),
    })
    const plain = io()
    await runVerifyCli(['--app', world.app, '--host', world.host, '--only', 'guards'], plain.io)
    expect(plain.out.join('')).not.toContain('pack source:')
    const explained = io()
    await runVerifyCli(
      ['--app', world.app, '--host', world.host, '--only', 'guards', '--explain'],
      explained.io
    )
    expect(explained.out.join('')).toContain(
      'src/lib/_cm/brand/theme.css (pack source: brand/theme.css)'
    )
  })
})
