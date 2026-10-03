import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compose } from '../src/compose.js'
import { sha256Hex } from '../src/hash.js'
import { runVerifyCli } from '../src/verify-cli.js'
import { acquireRunLock, verify } from '../src/verify.js'
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
const BAD_TOKEN = 'FORBIDDEN_TOKEN'
const LICENSE = 'AGPL-3.0-or-later'
const LOCK_FILE = 'composition.lock.json'
const UTIL = 'src/lib/util.ts'
const UTIL_TEST = 'src/lib/util.test.ts'

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
}

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
      packFiles: { [UTIL]: 'export const fmt = String\n' },
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
    process.env.PV_GUARD_APP_ROOT = '/caller-value'
    try {
      const report = await verify(options(world))
      expect(report.tests?.failures).toEqual([])
      expect(report.tests?.ok).toBe(true)
      expect(process.env.PV_GUARD_APP_ROOT).toBe('/caller-value')
    } finally {
      delete process.env.PV_GUARD_APP_ROOT
    }
  })

  it('runs one step with --only', async () => {
    const world = await composedWorld()
    const guardsOnly = await verify({ ...options(world), only: 'guards' })
    expect(guardsOnly.tests).toBeUndefined()
    const testsOnly = await verify({ ...options(world), only: 'tests' })
    expect(testsOnly.guards).toBeUndefined()
  })
})

describe('pv-verify run lock (Story 68.9 AC-15 concurrency)', () => {
  it('fails fast on a second run on one app root and replaces a stale lock', () => {
    const world = makeWorld()
    const first = acquireRunLock(world.app)
    expect('release' in first).toBe(true)
    expect(acquireRunLock(world.app)).toEqual({ heldBy: process.pid })
    if ('release' in first) first.release()
    expect(existsSync(join(world.app, '.pv-compose', 'verify.lock'))).toBe(false)
    writeFileSync(join(world.app, '.pv-compose', 'verify.lock'), '2147483646')
    const replaced = acquireRunLock(world.app)
    expect('release' in replaced).toBe(true)
    if ('release' in replaced) replaced.release()
  })
})

describe('pv-verify command line (Story 68.9 AC-9, Q5)', () => {
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } }
  }

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
    expect(flags).toEqual(['--app', '--host', '--pack', '--only', '--explain', '--json'])
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
