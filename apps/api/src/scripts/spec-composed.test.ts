import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  API_ROUTES_FIXTURE_PACKAGE,
  importApiRoutesFixture,
} from '../__tests__/helpers/api-routes-fixture.js'
import { prepareSpecGenerationEnv } from './spec-env.js'

/**
 * Story 68.14 AC-3 — `generate-spec --extension <pkg> --out <path>`: argument parsing, the
 * refusal to overwrite PV's committed spec through any spelling, the atomic write and the
 * composed document of the fixture extension, in process and through the real CLI.
 */
prepareSpecGenerationEnv(process.env)
process.env['ENABLE_API_DOCS'] = 'true'

const { createApp } = await import('../app.js')
const { getExtensionStatus, __resetExtensionStateForTests } =
  await import('../extensions/loader.js')
const { __resetCapabilityGateForTests } = await import('../lib/capability-gate.js')
const { __resetAuthStrategiesForTests } = await import('../modules/auth/strategies.js')
const {
  SpecLoadError,
  SpecUsageError,
  generateComposedSpec,
  parseSpecArgs,
  resolveOutPath,
  writeFileAtomic,
} = await import('./spec-composed.js')
const fixture = await importApiRoutesFixture()

const EXTENSION_FLAG = '--extension'
const OUT_FLAG = '--out'
const MISSING_PACKAGE = '@nope/missing-68-14'
const PV_SPEC = resolve(import.meta.dirname, '../../../../packages/shared/openapi.json')
const API_DIR = resolve(import.meta.dirname, '../..')
const COMPOSED_FILE = 'composed.json'
const NEEDS_VALUE = 'needs a value'
const MORE_THAN_ONCE = 'more than once'
const PV_SPEC_MESSAGE = 'PV committed spec'
const GENERATE_SPEC = 'src/scripts/generate-spec.ts'

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

function resetWorld(scenario: Parameters<typeof fixture.setApiRoutesScenario>[0] = 'default') {
  __resetExtensionStateForTests()
  __resetCapabilityGateForTests()
  __resetAuthStrategiesForTests()
  fixture.resetObserved()
  fixture.setApiRoutesScenario(scenario)
}

describe('parseSpecArgs', () => {
  it('no arguments: the PV-only mode', () => {
    expect(parseSpecArgs([])).toEqual({ mode: 'pv' })
  })

  it('both flags: the composed mode', () => {
    expect(parseSpecArgs([EXTENSION_FLAG, '@cm/pack', OUT_FLAG, COMPOSED_FILE])).toEqual({
      mode: 'composed',
      extension: '@cm/pack',
      out: COMPOSED_FILE,
    })
    expect(parseSpecArgs([OUT_FLAG, 'x.json', EXTENSION_FLAG, 'pack'])).toMatchObject({
      mode: 'composed',
    })
  })

  it.each([
    [[EXTENSION_FLAG, 'pack'], 'must be given together'],
    [[OUT_FLAG, 'x.json'], 'must be given together'],
    [[EXTENSION_FLAG, 'a', EXTENSION_FLAG, 'b', OUT_FLAG, 'x'], MORE_THAN_ONCE],
    [[EXTENSION_FLAG, 'a', OUT_FLAG, 'x', OUT_FLAG, 'y'], MORE_THAN_ONCE],
    [['--nope'], 'unknown argument'],
    [[EXTENSION_FLAG, '', OUT_FLAG, 'x'], NEEDS_VALUE],
    [[EXTENSION_FLAG, 'a', OUT_FLAG], NEEDS_VALUE],
    [[EXTENSION_FLAG, OUT_FLAG, 'x'], NEEDS_VALUE],
    [[EXTENSION_FLAG, './local', OUT_FLAG, 'x'], 'bare package specifier'],
    [[EXTENSION_FLAG, 'https://x.test/p', OUT_FLAG, 'x'], 'bare package specifier'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseSpecArgs(argv)).toThrow(SpecUsageError)
    expect(() => parseSpecArgs(argv)).toThrow(message)
  })
})

describe('resolveOutPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-composed-'))
  const fakeSpec = join(dir, 'pv-openapi.json')
  const hardLink = join(dir, 'hard.json')
  const symLink = join(dir, 'sym.json')
  const folder = join(dir, 'folder')

  beforeAll(() => {
    writeFileSync(fakeSpec, '{}\n')
    linkSync(fakeSpec, hardLink)
    symlinkSync(fakeSpec, symLink)
    mkdirSync(folder)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses every spelling of the PV spec path', () => {
    const spellings = [
      fakeSpec,
      relative(process.cwd(), fakeSpec),
      join(dir, 'folder', '..', 'pv-openapi.json'),
      `${dir}//pv-openapi.json`,
      symLink,
      hardLink,
    ]
    for (const spelling of spellings) {
      expect(() => resolveOutPath(spelling, fakeSpec)).toThrow(SpecUsageError)
      expect(() => resolveOutPath(spelling, fakeSpec)).toThrow(PV_SPEC_MESSAGE)
    }
  })

  it('refuses the real PV spec path in the same spellings', () => {
    expect(() => resolveOutPath(PV_SPEC, PV_SPEC)).toThrow(PV_SPEC_MESSAGE)
    expect(() =>
      resolveOutPath(`${relative(process.cwd(), resolve(PV_SPEC, '..'))}//openapi.json`, PV_SPEC)
    ).toThrow(PV_SPEC_MESSAGE)
  })

  it('refuses a missing parent directory and an existing directory', () => {
    expect(() => resolveOutPath(join(dir, 'nope', 'x.json'), fakeSpec)).toThrow(
      'parent directory must exist'
    )
    expect(() => resolveOutPath(folder, fakeSpec)).toThrow('is a directory')
  })

  it('accepts a new file and an existing different file, returning the absolute path', () => {
    expect(resolveOutPath(join(dir, COMPOSED_FILE), fakeSpec)).toBe(join(dir, COMPOSED_FILE))
    const other = join(dir, 'other.json')
    writeFileSync(other, '{}')
    expect(resolveOutPath(other, fakeSpec)).toBe(other)
  })
})

describe('writeFileAtomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-composed-write-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes through a same-directory temp file and leaves nothing behind', () => {
    const target = join(dir, 'out.json')
    writeFileAtomic(target, 'first')
    writeFileAtomic(target, 'second')
    expect(readFileSync(target, 'utf8')).toBe('second')
    expect(readdirSync(dir)).toEqual(['out.json'])
  })
})

describe('generateComposedSpec (in process)', () => {
  beforeAll(() => resetWorld())
  afterEach(() => resetWorld())

  const deps = { createApp, getExtensionStatus }

  it('contains the fixture added routes and the overridden route effective schema', async () => {
    const text = await generateComposedSpec({ extension: API_ROUTES_FIXTURE_PACKAGE }, deps)
    const document = JSON.parse(text) as {
      info: { title: string }
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>
    }
    expect(document.info.title).toBe('Project Vault API')
    expect(Object.keys(document.paths)).toContain('/api/v1/cm/documents')
    const overridden = JSON.stringify(
      document.paths['/api/v1/projects/{projectId}']?.['get']?.responses
    )
    expect(overridden).toContain('cmTiles')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('is deterministic: two runs are byte-identical', async () => {
    const first = await generateComposedSpec({ extension: API_ROUTES_FIXTURE_PACKAGE }, deps)
    resetWorld()
    const second = await generateComposedSpec({ extension: API_ROUTES_FIXTURE_PACKAGE }, deps)
    expect(second).toBe(first)
  })

  it('a package that cannot be imported fails with the loader import_error reason', async () => {
    await expect(generateComposedSpec({ extension: MISSING_PACKAGE }, deps)).rejects.toThrow(
      SpecLoadError
    )
    resetWorld()
    await expect(generateComposedSpec({ extension: MISSING_PACKAGE }, deps)).rejects.toThrow(
      'import_error'
    )
  })

  it('a pack above the host API version fails negotiation the same way', async () => {
    resetWorld('above-host')
    await expect(
      generateComposedSpec({ extension: API_ROUTES_FIXTURE_PACKAGE }, deps)
    ).rejects.toThrow('capability_mismatch')
  })

  it('a boot failure (override drift) rejects with the route-key message', async () => {
    resetWorld('missing-target')
    await expect(
      generateComposedSpec({ extension: API_ROUTES_FIXTURE_PACKAGE }, deps)
    ).rejects.toThrow('apiRoutes.override targets not found')
  })
})

describe('the generate-spec CLI process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-composed-cli-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync('pnpm', ['exec', 'tsx', GENERATE_SPEC, ...args], {
      cwd: API_DIR,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    })

  it('writes the composed document and leaves the PV spec byte-identical', () => {
    const before = sha256(PV_SPEC)
    const out = join(dir, COMPOSED_FILE)
    const result = run([EXTENSION_FLAG, API_ROUTES_FIXTURE_PACKAGE, OUT_FLAG, out], {
      VAULT_EXTENSIONS_REQUIRED: 'true',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(API_ROUTES_FIXTURE_PACKAGE)
    const document = JSON.parse(readFileSync(out, 'utf8')) as { paths: Record<string, unknown> }
    expect(Object.keys(document.paths)).toContain('/api/v1/cm/documents')
    expect(sha256(PV_SPEC)).toBe(before)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  }, 120_000)

  it('without flags the PV spec stays byte-identical even with the fixture set in the shell', () => {
    const before = sha256(PV_SPEC)
    const result = run([], { VAULT_EXTENSIONS_PACKAGE: API_ROUTES_FIXTURE_PACKAGE })
    expect(result.status).toBe(0)
    expect(sha256(PV_SPEC)).toBe(before)
  }, 120_000)

  it('exits 1 with the loader reason and does not create --out for a missing package', () => {
    const out = join(dir, 'never.json')
    const result = run([EXTENSION_FLAG, MISSING_PACKAGE, OUT_FLAG, out])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('import_error')
    expect(existsSync(out)).toBe(false)
  }, 120_000)

  it('exits 2 for a usage error and for --out resolving to the PV spec, writing nothing', () => {
    const before = sha256(PV_SPEC)
    const lonely = run([EXTENSION_FLAG, API_ROUTES_FIXTURE_PACKAGE])
    expect(lonely.status).toBe(2)
    expect(lonely.stderr).toContain('usage: generate-spec')
    const refused = run([
      EXTENSION_FLAG,
      API_ROUTES_FIXTURE_PACKAGE,
      OUT_FLAG,
      relative(API_DIR, PV_SPEC),
    ])
    expect(refused.status).toBe(2)
    expect(sha256(PV_SPEC)).toBe(before)
  }, 120_000)
})
