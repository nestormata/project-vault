import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT, STAGE_DIR, packWebHost } from './pack-web-host.js'
import { makeRecipe } from './lib/ci-wiring.js'
import { resolveBin, resolveTrustedExecutable, trustedGit } from './lib/trusted-executable.js'
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

function runVariant(
  variant: string,
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
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
      // Story 68.5 AC-12 (M4): the same run replaces a shell component (wrapped through
      // `pv-original:`), a `$lib/api` module and a `$lib/server` module, and PV's own files get them.
      expect(output).toContain('OK: /login, /billing, /billing/export, /recovery, /m4 served')
      expect(output).toContain('OK: an unknown injection point fails with the way out')
      expect(output).toContain(
        'OK: injected markup (in order), load data, layout point, shell head and action served'
      )
      // Story 68-6: hook bundles, derived protection, the reroute bypass and the CM policy delta.
      expect(output).toContain(
        'OK: server hook code stays out of the client bundle; universal/client hooks reach it'
      )
      expect(output).toContain(
        'OK: AC-9 table (anonymous, session-expired, sealed, authenticated, CSRF) with handler counters; handleFetch, transport, init, handleError and the CM policy applied'
      )
      expect(output).toContain(
        'pv-compose: protected paths: 5 derived (app) routes, 1 added, 1 removed'
      )
      // Code review 68-6: AC-8 derived ids vs Kit's route list, the remaining AC-9 rows, and the
      // header-policy delta printed by composed-hooks-init.test.ts in the composed tree (Q3).
      expect(output).toContain('OK: 5 derived route ids are all Kit routes')
      expect(output).toContain(
        'OK: protectedPaths add/remove, CM shares override, refreshed cookies (incl. an immutable proxied response) and the rerouted action'
      )
      expect(output).toContain('pv-compose: header policy: added defaults.x-cm-policy')
      expect(output).toContain('pv-compose: header policy: added rules.cm-billing')
      expect(status, output).toBe(0)
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'fails `vite build` with the pv-replace message when the map names a CM file that is missing (Story 68.5 AC-12)',
    () => {
      const { status, output } = runVariant('compose-missing-with')
      expect(status, output).not.toBe(0)
      expect(output).toContain(
        'pv-replace: replacement for src/lib/components/shell/Footer.svelte points at missing src/lib/_cm/replacements/Footer.svelte; run pv-compose.'
      )
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
    "Kit's server-only guard still rejects a client import of a REPLACED $lib/server module, naming the _cm path (Story 68.5 AC-4)",
    () => {
      const leak = runVariant('compose-replace-leak')
      expect(leak.status, leak.output).not.toBe(0)
      expect(leak.output).toMatch(/Cannot import .* into code that runs in the browser/)
      expect(leak.output).toContain('$lib/server/_cm/server/require-user.ts')
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    "why plugin order matters (Story 68.5 Q6): with pvReplace() listed BEFORE sveltekit(), the guard can't walk the same client import back to its page",
    () => {
      const first = runVariant('compose-replace-first-leak')
      // The build still fails (the replaced module stays server-only), but SvelteKit's guard has
      // not seen the import that reached it and reports "An impossible situation occurred".
      expect(first.status, first.output).not.toBe(0)
      expect(first.output).toContain('An impossible situation occurred')
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'the Vite dev plugin mirrors a pack edit, an added route and a deleted override',
    () => {
      const { status, output } = runVariant('compose-dev')
      expect(output).toContain('OK: dev mode mirrored an edit, an addition and a deleted override')
      expect(output).toContain('OK: dev mode protected a CM (app) route added while running')
      expect(status, output).toBe(0)
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    "Kit's server-only guard rejects a client import of virtual:pv-hooks/server (Story 68-6 AC-1)",
    () => {
      const { status, output } = runVariant('compose-hooks-leak')
      expect(status, output).not.toBe(0)
      expect(output).toMatch(
        /Cannot import .*_cm\/hooks\.server.* into code that runs in the browser/
      )
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'a full-file override of src/hooks.server.ts composes, builds, serves and keeps derived protection (Story 68-6 AC-11)',
    () => {
      const { status, output } = runVariant('compose-full-override')
      expect(output).toContain(
        'OK: a full override of src/hooks.server.ts composes, builds, serves and keeps derived protection'
      )
      expect(status, output).toBe(0)
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    'an invalid pack headerPolicy fails composed-hooks-init.test.ts before any build (Story 68-6 AC-6)',
    () => {
      const { status, output } = runVariant('compose-bad-policy')
      expect(status, output).not.toBe(0)
      expect(output).toContain('composed-hooks-init.test.ts')
      expect(output).toContain('header "x-cm-policy" must be a non-empty string')
    },
    VARIANT_TIMEOUT_MS
  )

  it(
    "PV's own packed web-host answers exactly as main's did (Story 68-6 AC-3)",
    () => {
      // pv-responses.main.json was recorded from main's (c4482a44) packed web-host with the same
      // pv-responses.sh; the variant diffs the current packed web-host's answers against it.
      const { status, output } = runVariant('pv-responses', {
        WEB_HOST_FIXTURE_RESPONSES_EXPECTED: join(
          repositoryRoot,
          'scripts',
          'web-host-consumer-fixture',
          'pv-responses.main.json'
        ),
      })
      expect(output).toContain("OK: PV's responses equal the main snapshot")
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

  it('no fixture file the integration copies is gitignored, so CI composes what a dev composes (Story 68-6)', () => {
    // A root .gitignore pattern (Stryker's `reports/`) once hid the mini pack's
    // `(app)/(nested)/reports/[id]` route: present on disk, never committed, so only CI lacked it.
    // `--cached --others` lists tracked and untracked files that match an ignore pattern.
    const ignored = trustedGit(repositoryRoot, [
      'ls-files',
      '--cached',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      'packages/composition-kit/tests/fixtures',
      'scripts/web-host-consumer-fixture',
    ])
    expect(ignored.split('\n').filter(Boolean)).toEqual([])
  })

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
