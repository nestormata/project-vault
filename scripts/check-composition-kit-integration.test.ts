import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, STAGE_DIR, packWebHost } from './pack-web-host.js'
import { makeRecipe } from './lib/ci-wiring.js'
import { resolveBin, resolveTrustedExecutable } from './lib/trusted-executable.js'
import { extensionApiVersion, packInto, resolveExtensionApi } from './lib/web-host/fixture-pack.js'
import { parseYaml } from './lib/yaml.js'

// Story 68.3 AC-12/AC-13: the composition kit composes a small UI pack onto the REAL packed
// web-host, in an isolated consumer (fresh temp dir outside the repository, `env -i`, the packed
// tarballs only, nothing linked from the workspace), then runs paraglide compile, svelte-kit sync,
// svelte-check, the shipped unit tests, vite build, boots the built server and asserts over HTTP and
// in the built CSS. Variants prove the negative cases (a lying `./$types`, a client import of
// server-only CM code) and the Vite dev plugin. The steps live in
// scripts/web-host-consumer-fixture/compose-mode.sh, driven through run.sh.
//
// Slow (a clean npm install and a Vite build per variant), so it runs only with
// COMPOSITION_KIT_INTEGRATION=1: in CI's `Composition kit integration` job (a wiring test below
// asserts it is set there) and via `make composition-kit-integration`.

const repositoryRoot = join(import.meta.dirname, '..')
const ENABLED = process.env.COMPOSITION_KIT_INTEGRATION === '1'
const FIXTURE_SCRIPT = join(REPO_ROOT, 'scripts', 'web-host-consumer-fixture', 'run.sh')
const KIT_DIR = join(REPO_ROOT, 'packages', 'composition-kit')
const FIXTURES_DIR = join(KIT_DIR, 'tests', 'fixtures')
const VARIANT_TIMEOUT_MS = 1_200_000

if (!ENABLED) {
  process.stderr.write(
    '\n*** SKIPPED: the composition kit integration job (Story 68.3 AC-12) did NOT run. ***\n' +
      '*** Run it with `make composition-kit-integration`; CI always runs it.          ***\n\n'
  )
}

let workDir = ''
let webHostTarball = ''
let kitTarball = ''
let extensionApiTarball: string | undefined
const timings = new Map<string, number>()

/** The version PV's web app has installed (the consumer pins the same, exactly). */
function webVersion(name: string): string {
  const requireFromWeb = createRequire(join(REPO_ROOT, 'apps', 'web', 'package.json'))
  return (requireFromWeb(`${name}/package.json`) as { version: string }).version
}

function runVariant(variant: string): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEB_HOST_FIXTURE_CACHE: join(workDir, 'npm-cache'),
    COMPOSITION_KIT_TARBALL: kitTarball,
    COMPOSITION_KIT_FIXTURES: FIXTURES_DIR,
    COMPOSITION_KIT_SVELTE_CHECK: webVersion('svelte-check'),
    COMPOSITION_KIT_TYPES_NODE: webVersion('@types/node'),
  }
  if (extensionApiTarball !== undefined)
    env.WEB_HOST_FIXTURE_EXTENSION_API_TARBALL = extensionApiTarball
  const started = Date.now()
  const run = spawnSync(
    resolveTrustedExecutable('bash'),
    [FIXTURE_SCRIPT, webHostTarball, variant],
    {
      encoding: 'utf8',
      env,
      timeout: VARIANT_TIMEOUT_MS,
    }
  )
  timings.set(variant, Math.round((Date.now() - started) / 1000))
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` }
}

describe.runIf(ENABLED)('composition kit integration (Story 68.3 AC-12, AC-13)', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'composition-kit-integration-'))
    const { packageJson } = await packWebHost({
      version: '0.0.0-fixture',
      repository: 'nestormata/project-vault',
      log: () => undefined,
    })
    webHostTarball = packInto(STAGE_DIR, workDir)
    // The kit is built and packed the way the release workflow does it.
    rmSyncDist()
    const build = spawnSync(
      process.execPath,
      [resolveBin('typescript', 'tsc', KIT_DIR), '-p', 'tsconfig.build.json'],
      { cwd: KIT_DIR, encoding: 'utf8' }
    )
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0)
    kitTarball = packInto(KIT_DIR, workDir)
    const extensionApi = extensionApiVersion(packageJson.dependencies as Record<string, string>)
    expect(extensionApi, 'web-host depends on an exact extension-api version').toBeDefined()
    extensionApiTarball = resolveExtensionApi(extensionApi ?? '', workDir)
  }, 600_000)

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
    process.stderr.write(
      `composition-kit-integration: variant seconds ${JSON.stringify(Object.fromEntries(timings))}\n`
    )
  })

  it(
    'composes the mini pack onto the packed web-host, typechecks, builds, boots and serves it',
    () => {
      const { status, output } = runVariant('compose')
      expect(output).toContain('OK: /login, /billing, /billing/export, /recovery served')
      expect(output).toContain('OK: an unknown injection point fails with the way out')
      expect(output).toContain(
        'OK: injected markup (in order), load data, layout point, shell head and action served'
      )
      expect(status, output).toBe(0)
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'svelte-check fails when a page reads a field its load does not return (./$types is live)',
    () => {
      const { status, output } = runVariant('compose-types-negative')
      expect(status, output).not.toBe(0)
      expect(output).toContain("'nope' does not exist")
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    "Kit's server-only guard rejects a client import of materialized server-only CM code",
    () => {
      const leak = runVariant('compose-server-leak')
      expect(leak.status, leak.output).not.toBe(0)
      expect(leak.output).toMatch(/Cannot import .* into code that runs in the browser/)
      const twin = runVariant('compose-server-twin')
      expect(twin.status, twin.output).toBe(0)
      expect(twin.output).toContain('OK: vite build succeeded for compose-server-twin')
    },
    VARIANT_TIMEOUT_MS * 2
  )

  it(
    'the Vite dev plugin mirrors a pack edit, an added route and a deleted override',
    () => {
      const { status, output } = runVariant('compose-dev')
      expect(output).toContain('OK: dev mode mirrored an edit, an addition and a deleted override')
      expect(status, output).toBe(0)
    },
    VARIANT_TIMEOUT_MS
  )
})

function rmSyncDist(): void {
  rmSync(join(KIT_DIR, 'dist'), { recursive: true, force: true })
}

describe('composition kit integration: wiring (Story 68.3 AC-12)', () => {
  const command = 'pnpm vitest run scripts/check-composition-kit-integration.test.ts'

  it('the CI Composition kit integration job runs it with COMPOSITION_KIT_INTEGRATION=1, so it can never skip there', () => {
    const ci = parseYaml(
      readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    ) as {
      jobs: Record<
        string,
        {
          name?: string
          env?: Record<string, string>
          'timeout-minutes'?: number
          steps: { run?: string; env?: Record<string, string> }[]
        }
      >
    }
    const job = Object.values(ci.jobs).find(
      (candidate) => candidate.name === 'Composition kit integration'
    )
    expect(job, 'ci.yml has a job named "Composition kit integration"').toBeDefined()
    const step = job?.steps.find((candidate) => candidate.run?.includes(command))
    expect(step, 'the job runs the integration test').toBeDefined()
    expect(step?.env?.COMPOSITION_KIT_INTEGRATION ?? job?.env?.COMPOSITION_KIT_INTEGRATION).toBe(
      '1'
    )
    expect(job?.['timeout-minutes']).toBeGreaterThanOrEqual(30)
  })

  it('make composition-kit-integration runs it with COMPOSITION_KIT_INTEGRATION=1', () => {
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    expect(makeRecipe(makefile, 'composition-kit-integration')).toContain(
      `COMPOSITION_KIT_INTEGRATION=1 ${command}`
    )
  })
})
