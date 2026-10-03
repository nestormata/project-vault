import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, STAGE_DIR, packWebHost } from './pack-web-host.js'
import { makeRecipe } from './lib/ci-wiring.js'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'
import { extensionApiVersion, packInto, resolveExtensionApi } from './lib/web-host/fixture-pack.js'
import { parseYaml } from './lib/yaml.js'

// Story 68.2 AC-8: an out-of-monorepo consumer installs the packed tarball (and nothing from the
// workspace), compiles messages, syncs and builds with the exported factories, then boots the built
// server and renders /login. Two broken tarballs must fail: no vendored shared source, and a
// missing runtime dependency (proving the computed dependency set is load-bearing). The isolation
// itself lives in scripts/web-host-consumer-fixture/run.sh.
//
// Slow (three clean npm installs and builds), so it runs only with WEB_HOST_FIXTURE=1: in CI's
// `Web-host pack` job (a wiring test below asserts it is set there) and via `make web-host-fixture`.

// Static anchor (a local constant, unlike the imported REPO_ROOT) for the files read below.
const repositoryRoot = join(import.meta.dirname, '..')
const ENABLED = process.env.WEB_HOST_FIXTURE === '1'
const FIXTURE_SCRIPT = join(REPO_ROOT, 'scripts', 'web-host-consumer-fixture', 'run.sh')
const VARIANT_TIMEOUT_MS = 900_000

if (!ENABLED) {
  process.stderr.write(
    '\n*** SKIPPED: the web-host out-of-monorepo consumer fixture (Story 68.2 AC-8) did NOT run. ***\n' +
      '*** Run it with `make web-host-fixture` (sets WEB_HOST_FIXTURE=1); CI always runs it.   ***\n\n'
  )
}

let workDir = ''
let tarball = ''
/** A tarball of packages/extension-api, set only when its exact version is not on npm yet. */
let extensionApiTarball: string | undefined

function runFixture(variant: string): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEB_HOST_FIXTURE_CACHE: join(workDir, 'npm-cache'),
  }
  if (extensionApiTarball !== undefined) {
    // run.sh installs this tarball instead of the (unpublished) registry version.
    env.WEB_HOST_FIXTURE_EXTENSION_API_TARBALL = extensionApiTarball
  }
  const run = spawnSync(resolveTrustedExecutable('bash'), [FIXTURE_SCRIPT, tarball, variant], {
    encoding: 'utf8',
    env,
    timeout: VARIANT_TIMEOUT_MS,
  })
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` }
}

describe.runIf(ENABLED)('web-host consumer fixture (Story 68.2 AC-8)', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'web-host-fixture-'))
    const { packageJson } = await packWebHost({
      version: '0.0.0-fixture',
      repository: 'nestormata/project-vault',
      log: () => undefined,
    })
    tarball = packInto(STAGE_DIR, workDir)
    const extensionApi = extensionApiVersion(packageJson.dependencies as Record<string, string>)
    expect(extensionApi, 'web-host depends on an exact extension-api version').toBeDefined()
    extensionApiTarball = resolveExtensionApi(extensionApi ?? '', workDir)
  }, 300_000)

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
  })

  it(
    'installs, compiles, syncs, builds, runs the shipped unit tests and renders /login from the tarball alone',
    () => {
      const { status, output } = runFixture('ok')
      expect(output).toContain('OK: /login server-rendered the sign-in form')
      // Story 68.2 (Nestor 2026-10-02): the shipped self-contained unit tests pass from the package.
      expect(output).toMatch(/OK: \d{3,} shipped unit test files passed/)
      expect(status, output).toBe(0)
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'fails without the vendored shared source',
    () => {
      const { status, output } = runFixture('missing-vendored-shared')
      expect(status, output).not.toBe(0)
      expect(output).not.toContain('OK: /login')
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'fails when a computed runtime dependency (cron-parser) is missing',
    () => {
      const { status, output } = runFixture('missing-dependency')
      expect(status, output).not.toBe(0)
      expect(output).toContain('cron-parser')
    },
    VARIANT_TIMEOUT_MS
  )
})

describe('web-host consumer fixture: wiring (Story 68.2 AC-8/AC-10)', () => {
  const command = 'pnpm vitest run scripts/check-web-host-consumer-fixture.test.ts'

  it('the CI Web-host pack job runs the fixture with WEB_HOST_FIXTURE=1, so it can never skip there', () => {
    const ci = parseYaml(
      readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    ) as {
      jobs: Record<
        string,
        {
          name?: string
          env?: Record<string, string>
          steps: { run?: string; env?: Record<string, string> }[]
        }
      >
    }
    const job = Object.values(ci.jobs).find((candidate) => candidate.name === 'Web-host pack')
    expect(job, 'ci.yml has a job named "Web-host pack"').toBeDefined()
    const step = job?.steps.find((candidate) => candidate.run?.includes(command))
    expect(step, 'the job runs the fixture test').toBeDefined()
    expect(step?.env?.WEB_HOST_FIXTURE ?? job?.env?.WEB_HOST_FIXTURE).toBe('1')
  })

  it('make web-host-fixture runs it with WEB_HOST_FIXTURE=1', () => {
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    expect(makeRecipe(makefile, 'web-host-fixture')).toContain(`WEB_HOST_FIXTURE=1 ${command}`)
  })
})
