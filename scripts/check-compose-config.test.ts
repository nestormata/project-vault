// Story 60.1 AC5 — the first `docker compose config`-based test in this repository (confirmed by
// story creation: no existing test/script ran `docker compose config` before this). Guards
// against a future edit to docker-compose.yml silently dropping the web service's
// CORS_ALLOWED_ORIGINS key (Finding F1's regression: apps/web's own CORS check was always-false
// because that key never reached its process).
//
// `docker compose config` only renders/merges YAML — it needs the Docker CLI but NOT a running
// daemon (confirmed directly in this project's cloud dev environment: `docker ps` fails with no
// daemon socket while `docker compose config --format json` still exits 0). If the CLI itself is
// genuinely absent (not just a daemon), this suite skips with the real reason logged rather than
// failing the whole run — see the `describeOrSkip` guard below. Story 60.7 AC3: in CI (CI=true)
// a missing CLI is a named failing test instead, and this suite runs on the HOST side of `make ci`
// plus in ci.yml's `checks` job (the self-wiring test at the bottom of this file guards both).
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { COMPOSE_REQUIRED_IN_CI_MESSAGE, resolveComposeGuard } from './lib/compose-guard.js'

const repoRoot = resolve(process.cwd())
const COMPOSE_FILE_NAME = 'docker-compose.yml'
const composeFile = join(repoRoot, COMPOSE_FILE_NAME)

// Story 60.7: repo files read at transform time by Vite as raw text (the lint-clean loading
// pattern of check-action-pins.test.ts / e2e-stack.test.ts). Compose itself still renders from
// the real paths on disk.
const REPO_TEXT: Record<string, string> = import.meta.glob(
  ['../docker-compose.yml', '../.github/workflows/ci.yml'],
  { query: '?raw', import: 'default', eager: true }
)
// `[e]` makes this a glob: vite:import-glob rejects the bare, extension-less `../Makefile` literal.
const MAKEFILE_TEXT: Record<string, string> = import.meta.glob('../Makefil[e]', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function repoText(key: '../docker-compose.yml' | '../.github/workflows/ci.yml'): string {
  const text = Object.entries(REPO_TEXT).find(([candidate]) => candidate === key)?.[1]
  expect(text, `${key} must exist`).toBeDefined()
  return text ?? ''
}

function composeText(): string {
  return repoText('../docker-compose.yml')
}

/** Elicitation finding (Boundary & Edge Case Sweep, integrated into AC5) — Compose auto-loads a
 * project-root `.env` if present, which would make a naive default-value assertion flaky
 * depending on the caller's ambient `.env`. Pointing `--env-file` at the always-empty null device
 * keeps the rendered defaults deterministic in every environment, regardless of what the caller's
 * own `.env` (if any) contains. Nothing is written to disk: test variables go through the child
 * environment and modified compose YAML through stdin (see renderComposeConfig). */
const NO_ENV_FILE = '/dev/null'

/** Code review (60-4): Compose gives the caller's shell environment precedence over `--env-file`,
 * so a variable exported in a developer's or CI shell (e.g. `VAULT_HANDOFF_ISSUER`) would silently
 * override the test-owned env file and break the default-value assertions. Every variable the
 * compose file interpolates (as listed by Compose itself) is dropped from the child's environment,
 * keeping the rest (PATH, HOME, DOCKER_*) that the Docker CLI itself needs. A Compose CLI too old
 * for `config --variables` falls back to the unfiltered environment (the pre-60-4 behaviour). */
// Story 60.7: `source` lets a test prove the isolation with a local env copy (never by mutating
// the real process.env); `files` allows a merged `-f base -f override` render.
function isolatedComposeEnv(
  fileArgs: string[],
  source: NodeJS.ProcessEnv = process.env,
  input?: string
): NodeJS.ProcessEnv {
  let interpolated: Set<string>
  try {
    const stdout = execFileSync(
      'docker',
      ['compose', ...fileArgs, 'config', '--variables', '--format', 'json'],
      { cwd: repoRoot, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] }
    )
    interpolated = new Set(Object.keys(JSON.parse(stdout) as Record<string, unknown>))
  } catch {
    return source
  }
  return Object.fromEntries(Object.entries(source).filter(([key]) => !interpolated.has(key)))
}

interface ComposeRender {
  /** Compose files to merge (`-f a -f b`); defaults to the real docker-compose.yml. */
  files?: string[]
  /** Compose YAML piped on stdin (`-f -`) instead of `files` — the regression fixtures, so a
   * modified copy never has to be written to disk. */
  yaml?: string
  /** Test interpolation variables. Compose gives the process environment precedence over
   * `--env-file`, so they are layered on top of the isolated environment. */
  vars?: Record<string, string>
  /** A real repository env file to interpolate from (defaults to none — see NO_ENV_FILE). */
  envFile?: string
  /** The caller environment to isolate (see isolatedComposeEnv). */
  source?: NodeJS.ProcessEnv
}

function renderComposeConfig({
  files = [composeFile],
  yaml,
  vars = {},
  envFile = NO_ENV_FILE,
  source,
}: ComposeRender = {}): Record<string, unknown> {
  const fileArgs =
    yaml === undefined
      ? files.flatMap((file) => ['-f', file])
      : ['-f', '-', '--project-directory', repoRoot]
  const stdout = execFileSync(
    'docker',
    ['compose', ...fileArgs, '--env-file', envFile, 'config', '--format', 'json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input: yaml,
      env: { ...isolatedComposeEnv(fileArgs, source, yaml), ...vars },
    }
  )
  return JSON.parse(stdout) as Record<string, unknown>
}

function dockerComposeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const composeGuard = resolveComposeGuard({
  ci: process.env['CI'],
  hasCompose: dockerComposeAvailable(),
})
const describeOrSkip = composeGuard === 'run' ? describe : describe.skip

if (composeGuard === 'skip') {
  // eslint-disable-next-line no-console
  console.warn(
    '[check-compose-config] SKIPPED: Docker CLI/Compose plugin not available in this ' +
      'environment — see Story 60.1 Dev Notes.'
  )
}

// Story 60.7 AC3.5: a throw at module load would crash collection with an unhelpful stack, so
// CI-without-Compose is reported as one clearly named failing test instead.
if (composeGuard === 'fail') {
  describe('docker compose config', () => {
    it('requires Docker Compose in CI', () => {
      throw new Error(COMPOSE_REQUIRED_IN_CI_MESSAGE)
    })
  })
}

describe('resolveComposeGuard (Story 60.7 AC3.3)', () => {
  it('skips outside CI when Compose is absent', () => {
    expect(resolveComposeGuard({ ci: undefined, hasCompose: false })).toBe('skip')
  })

  it('fails in CI when Compose is absent', () => {
    expect(resolveComposeGuard({ ci: 'true', hasCompose: false })).toBe('fail')
  })

  it('runs in CI when Compose is present', () => {
    expect(resolveComposeGuard({ ci: 'true', hasCompose: true })).toBe('run')
  })

  it.each(['false', ''])('treats CI=%j like an unset CI', (ci) => {
    expect(resolveComposeGuard({ ci, hasCompose: false })).toBe('skip')
    expect(resolveComposeGuard({ ci, hasCompose: true })).toBe('run')
  })
})

describeOrSkip('docker compose config — web service CORS_ALLOWED_ORIGINS (Story 60.1 AC5)', () => {
  it('renders a CORS_ALLOWED_ORIGINS key on the web service, unconditionally', () => {
    const rendered = renderComposeConfig()
    const services = rendered['services'] as Record<
      string,
      { environment?: Record<string, string> }
    >

    expect(services['web']?.environment).toHaveProperty('CORS_ALLOWED_ORIGINS')
  })

  it('defaults web.environment.CORS_ALLOWED_ORIGINS to the same value as api, under an isolated empty env-file', () => {
    const rendered = renderComposeConfig()
    const services = rendered['services'] as Record<
      string,
      { environment?: Record<string, string> }
    >

    expect(services['web']?.environment?.['CORS_ALLOWED_ORIGINS']).toBe('http://localhost:5173')
    expect(services['web']?.environment?.['CORS_ALLOWED_ORIGINS']).toBe(
      services['api']?.environment?.['CORS_ALLOWED_ORIGINS']
    )
  })

  // Failure/regression example (AC5): a copy of docker-compose.yml with the web service's
  // CORS_ALLOWED_ORIGINS line removed must fail this assertion, naming the missing key — proving
  // the test actually guards against the regression it exists to catch, not just passing today.
  it('fails the key-presence assertion against a docker-compose.yml missing the web CORS_ALLOWED_ORIGINS line', () => {
    const original = composeText()
    const regressed = original.replace(
      /\n\s*CORS_ALLOWED_ORIGINS: \$\{PUBLIC_WEB_ORIGIN:-http:\/\/localhost:\$\{WEB_HOST_PORT:-5173\}\}\$\{CORS_EXTRA_ORIGINS:\+,\$\{CORS_EXTRA_ORIGINS\}\}\n(\s*ports:\n\s*- '\$\{WEB_HOST_PORT)/,
      '\n$1'
    )
    // Guard the fixture itself: if the replace didn't match, this test would pass for the wrong
    // reason (a no-op edit), so fail loudly here instead.
    expect(regressed).not.toBe(original)

    const rendered = renderComposeConfig({ yaml: regressed })
    const services = rendered['services'] as Record<
      string,
      { environment?: Record<string, string> }
    >

    expect(services['web']?.environment).not.toHaveProperty('CORS_ALLOWED_ORIGINS')
  })
})

// Story 43.7 AC-6 — the operator's CLI version policy variables (Story 43.6) must reach the api
// container. docker-compose.yml's api service uses an explicit `environment:` map (no env_file),
// so a key missing from it silently never reaches the process: the documented "withdraw a CLI
// version" procedure then has no effect and no error.
const CLI_POLICY_KEYS = ['CLI_MINIMUM_SUPPORTED_VERSION', 'CLI_WITHDRAWN_VERSIONS'] as const
// A trusted CentralizeMe origin/issuer fixture (Stories 60.4 and 60.7).
const CM_ORIGIN = 'https://cm.example.test'

const CLI_POLICY_VARS = {
  CLI_MINIMUM_SUPPORTED_VERSION: '1.1.0',
  CLI_WITHDRAWN_VERSIONS: '1.2.1,1.2.2',
}

function renderedServices(render: ComposeRender = {}) {
  return renderComposeConfig(render)['services'] as Record<
    string,
    { environment?: Record<string, string> }
  >
}

describeOrSkip(
  'docker compose config — api CLI version policy passthrough (Story 43.7 AC-6)',
  () => {
    it('passes both keys to the api service as empty strings when unset (env.ts treats empty as no policy)', () => {
      const services = renderedServices()

      expect(services['api']?.environment).toMatchObject(
        Object.fromEntries(CLI_POLICY_KEYS.map((key) => [key, '']))
      )
    })

    it('passes the operator values through verbatim', () => {
      const services = renderedServices({ vars: CLI_POLICY_VARS })

      expect(services['api']?.environment?.['CLI_MINIMUM_SUPPORTED_VERSION']).toBe('1.1.0')
      expect(services['api']?.environment?.['CLI_WITHDRAWN_VERSIONS']).toBe('1.2.1,1.2.2')
    })

    it('does not pass either key to the web service (it never needs them)', () => {
      const services = renderedServices({ vars: CLI_POLICY_VARS })

      for (const key of CLI_POLICY_KEYS) {
        expect(services['web']?.environment).not.toHaveProperty(key)
      }
    })

    // Regression fixture: removing the two lines must make the keys disappear, proving the guard
    // catches exactly the G4 bug rather than passing vacuously.
    it('a docker-compose.yml missing the two passthrough lines renders without the keys', () => {
      const original = composeText()
      const regressed = original
        .replace(/\n\s*CLI_MINIMUM_SUPPORTED_VERSION: \$\{CLI_MINIMUM_SUPPORTED_VERSION:-\}/, '')
        .replace(/\n\s*CLI_WITHDRAWN_VERSIONS: \$\{CLI_WITHDRAWN_VERSIONS:-\}/, '')
      expect(regressed).not.toBe(original)

      const services = renderedServices({ yaml: regressed })

      for (const key of CLI_POLICY_KEYS) {
        expect(services['api']?.environment).not.toHaveProperty(key)
      }
    })
  }
)

// Story 60.4 AC6 — the /handoff consent page's "Return to CentralizeMe" link reads the web
// process's own VAULT_HANDOFF_ISSUER. Web defaults to EMPTY (link only when an operator explicitly
// configures a CM issuer — a baked default would put a CentralizeMe link on every self-hosted
// instance's reachable /handoff page); api defaults to its own zod default (an empty string would
// fail api boot validation, z.string().min(1)). One operator value must reach both services.
describeOrSkip(
  'docker compose config — VAULT_HANDOFF_ISSUER on web and api (Story 60.4 AC6)',
  () => {
    it('renders web.environment.VAULT_HANDOFF_ISSUER as an empty string by default', () => {
      const services = renderedServices()

      expect(services['web']?.environment).toHaveProperty('VAULT_HANDOFF_ISSUER')
      expect(services['web']?.environment?.['VAULT_HANDOFF_ISSUER']).toBe('')
    })

    it("renders api.environment.VAULT_HANDOFF_ISSUER as the api's own default", () => {
      const services = renderedServices()

      expect(services['api']?.environment?.['VAULT_HANDOFF_ISSUER']).toBe(
        'https://app.centralizeme.com'
      )
    })

    it('passes an operator-set issuer to both services', () => {
      const services = renderedServices({ vars: { VAULT_HANDOFF_ISSUER: CM_ORIGIN } })

      expect(services['web']?.environment?.['VAULT_HANDOFF_ISSUER']).toBe(CM_ORIGIN)
      expect(services['api']?.environment?.['VAULT_HANDOFF_ISSUER']).toBe(CM_ORIGIN)
    })
  }
)

// Story 60.7 AC1/AC2 — operators append trusted origins (e.g. CentralizeMe's) with the
// Compose-only CORS_EXTRA_ORIGINS; PV's own derived origin is always kept. The env-file
// CORS_ALLOWED_ORIGINS stays ignored under Compose: `make fix-ports` copies `.env.example`'s
// literal `http://localhost:5173` into every local config and never rewrites it, so a naive
// `${CORS_ALLOWED_ORIGINS:-…}` passthrough would lock every port-bumped worktree out of its own
// origin (Design Decision 1).
const PV_ORIGIN_EXPR = '${PUBLIC_WEB_ORIGIN:-http://localhost:${WEB_HOST_PORT:-5173}}'
const CORS_EXPR = `${PV_ORIGIN_EXPR}\${CORS_EXTRA_ORIGINS:+,\${CORS_EXTRA_ORIGINS}}`
const NAIVE_CORS_EXPR = `\${CORS_ALLOWED_ORIGINS:-${PV_ORIGIN_EXPR}}`
const CORS_LINE = `CORS_ALLOWED_ORIGINS: ${CORS_EXPR}`
const DEFAULT_ORIGIN = 'http://localhost:5173'

type RenderedServices = ReturnType<typeof renderedServices>

function corsOf(services: RenderedServices): { api?: string; web?: string } {
  return {
    api: services['api']?.environment?.['CORS_ALLOWED_ORIGINS'],
    web: services['web']?.environment?.['CORS_ALLOWED_ORIGINS'],
  }
}

/** Renders a copy of docker-compose.yml with `edit` applied, after proving the edit changed it. */
function renderedRegressed(
  edit: (original: string) => string,
  vars: Record<string, string>
): RenderedServices {
  const original = composeText()
  const regressed = edit(original)
  expect(regressed).not.toBe(original)
  return renderedServices({ yaml: regressed, vars })
}

describeOrSkip('docker compose config — CORS_EXTRA_ORIGINS passthrough (Story 60.7 AC1)', () => {
  it.each<[string, Record<string, string>, string]>([
    ['1: default', {}, DEFAULT_ORIGIN],
    ['2: CM appended', { CORS_EXTRA_ORIGINS: CM_ORIGIN }, `${DEFAULT_ORIGIN},${CM_ORIGIN}`],
    [
      '3: list + port bump',
      { WEB_HOST_PORT: '6100', CORS_EXTRA_ORIGINS: `${CM_ORIGIN},https://b.example.test` },
      `http://localhost:6100,${CM_ORIGIN},https://b.example.test`,
    ],
    [
      '4: public origin',
      { PUBLIC_WEB_ORIGIN: 'https://vault.example.com', CORS_EXTRA_ORIGINS: CM_ORIGIN },
      `https://vault.example.com,${CM_ORIGIN}`,
    ],
    ['5: empty extra, no trailing comma', { CORS_EXTRA_ORIGINS: '' }, DEFAULT_ORIGIN],
    [
      '6: the copied fix-ports literal never leaks through',
      { WEB_HOST_PORT: '6137', CORS_ALLOWED_ORIGINS: DEFAULT_ORIGIN },
      'http://localhost:6137',
    ],
  ])('example %s renders the same list on api and web', (_label, vars, expected) => {
    const services = renderedServices({ vars })

    expect(corsOf(services)).toEqual({ api: expected, web: expected })
  })

  it('example 7: keeps web ORIGIN (the CSRF origin) a single origin', () => {
    const services = renderedServices({ vars: { CORS_EXTRA_ORIGINS: CM_ORIGIN } })

    expect(services['web']?.environment?.['ORIGIN']).toBe(DEFAULT_ORIGIN)
  })

  it('example 8: keeps api WEB_BASE_URL (email links) a single origin', () => {
    const services = renderedServices({ vars: { CORS_EXTRA_ORIGINS: CM_ORIGIN } })

    expect(services['api']?.environment?.['WEB_BASE_URL']).toBe(DEFAULT_ORIGIN)
  })

  it('isolates a CORS_EXTRA_ORIGINS exported in the caller shell', () => {
    const shellEnv = { ...process.env, CORS_EXTRA_ORIGINS: 'https://shell-leak.example.test' }
    const services = renderedServices({ source: shellEnv })

    expect(corsOf(services)).toEqual({ api: DEFAULT_ORIGIN, web: DEFAULT_ORIGIN })
  })

  it('renders the real .env.example without the issuer link or the CORS literal (AC4.3)', () => {
    const services = renderedServices({ envFile: join(repoRoot, '.env.example') })

    expect(services['web']?.environment?.['VAULT_HANDOFF_ISSUER']).toBe('')
    expect(services['api']?.environment?.['VAULT_HANDOFF_ISSUER']).toBe(
      'https://app.centralizeme.com'
    )
    expect(corsOf(services)).toEqual({ api: DEFAULT_ORIGIN, web: DEFAULT_ORIGIN })
  })

  it('keeps the e2e override web allowlist stub-inclusive (AC7)', () => {
    const services = renderedServices({
      files: [composeFile, join(repoRoot, 'docker-compose.e2e.yml')],
    })

    expect(corsOf(services).web).toBe(`${DEFAULT_ORIGIN},http://127.0.0.1:48999`)
  })

  it('(a) detects the passthrough being removed: example 2 loses the CM origin', () => {
    const services = renderedRegressed(
      (original) => original.split(CORS_LINE).join(`CORS_ALLOWED_ORIGINS: ${PV_ORIGIN_EXPR}`),
      { CORS_EXTRA_ORIGINS: CM_ORIGIN }
    )

    expect(corsOf(services)).toEqual({ api: DEFAULT_ORIGIN, web: DEFAULT_ORIGIN })
  })

  it('(b) detects the naive passthrough: example 6 leaks the copied literal', () => {
    const services = renderedRegressed(
      (original) => original.split(CORS_LINE).join(`CORS_ALLOWED_ORIGINS: ${NAIVE_CORS_EXPR}`),
      { WEB_HOST_PORT: '6137', CORS_ALLOWED_ORIGINS: DEFAULT_ORIGIN }
    )

    expect(corsOf(services)).toEqual({ api: DEFAULT_ORIGIN, web: DEFAULT_ORIGIN })
  })

  it('(c) detects drift when only the web line changes', () => {
    const services = renderedRegressed(
      (original) => {
        const at = original.lastIndexOf(CORS_LINE)
        return `${original.slice(0, at)}CORS_ALLOWED_ORIGINS: ${PV_ORIGIN_EXPR}${original.slice(at + CORS_LINE.length)}`
      },
      { CORS_EXTRA_ORIGINS: CM_ORIGIN }
    )
    const { api, web } = corsOf(services)

    expect(api === web).toBe(false)
    expect(web).toBe(DEFAULT_ORIGIN)
  })

  it('uses the identical expression on both service lines', () => {
    expect(composeText().split(CORS_LINE)).toHaveLength(3)
  })
})

// Story 60.7 AC3.4 — outside describeOrSkip, so it always runs: this suite is wired into the HOST
// side of `make ci` (the ci container has no Docker CLI, so inside ci-inner it would only print
// SKIPPED) and into a ci.yml job.
const COMPOSE_SUITE_COMMAND = 'pnpm vitest run scripts/check-compose-config.test.ts'
const MAKE_CI_MISSING = 'Makefile `ci` recipe must run the compose-config suite on the host'

function composeSuiteWiringProblems(makefile: string, ciWorkflow: string): string[] {
  const problems: string[] = []
  if (!recipeRunsCommand(makeRecipe(makefile, 'ci'), COMPOSE_SUITE_COMMAND)) {
    problems.push(MAKE_CI_MISSING)
  }
  if (makeRecipe(makefile, 'ci-inner').includes('scripts/check-compose-config.test.ts')) {
    problems.push('Makefile `ci-inner` must not run the compose-config suite (no Docker CLI there)')
  }
  if (!workflowRunCommands(ciWorkflow).includes(COMPOSE_SUITE_COMMAND)) {
    problems.push('ci.yml must run the compose-config suite in a job step')
  }
  return problems
}

describe('check-compose-config wiring (Story 60.7 AC3.4)', () => {
  const makefile = Object.values(MAKEFILE_TEXT)[0] ?? ''
  const ciWorkflow = repoText('../.github/workflows/ci.yml')

  it('runs on the host side of make ci and in ci.yml, never inside ci-inner', () => {
    expect(composeSuiteWiringProblems(makefile, ciWorkflow)).toEqual([])
  })

  it('reports a Makefile ci recipe that lost the suite', () => {
    const fixture = makefile.replace(`\t${COMPOSE_SUITE_COMMAND}\n`, '')
    expect(fixture).not.toBe(makefile)

    expect(composeSuiteWiringProblems(fixture, ciWorkflow)).toContain(MAKE_CI_MISSING)
  })

  // Code review (60-7): a commented-out line, or make's `-` ignore-errors prefix, would keep the
  // text in the recipe while the suite no longer runs (or no longer fails `make ci`).
  it.each([
    ['commented out', `\t# ${COMPOSE_SUITE_COMMAND}\n`],
    ['ignore-errors prefixed', `\t-${COMPOSE_SUITE_COMMAND}\n`],
  ])('reports a Makefile ci recipe whose suite line is %s', (_label, replacement) => {
    const fixture = makefile.replace(`\t${COMPOSE_SUITE_COMMAND}\n`, replacement)
    expect(fixture).not.toBe(makefile)

    expect(composeSuiteWiringProblems(fixture, ciWorkflow)).toContain(MAKE_CI_MISSING)
  })

  it('reports the suite moved into ci-inner', () => {
    const fixture = makefile
      .replace('ci-inner: ##', 'ci-inner-moved: ##')
      .replace('ci: ##', `ci-inner: ##\n\t${COMPOSE_SUITE_COMMAND}\n\nci: ##`)

    expect(composeSuiteWiringProblems(fixture, ciWorkflow)).toContain(
      'Makefile `ci-inner` must not run the compose-config suite (no Docker CLI there)'
    )
  })

  it('reports a ci.yml without the suite step', () => {
    const fixture = ciWorkflow.replace(`run: ${COMPOSE_SUITE_COMMAND}`, 'run: echo removed')
    expect(fixture).not.toBe(ciWorkflow)

    expect(composeSuiteWiringProblems(makefile, fixture)).toContain(
      'ci.yml must run the compose-config suite in a job step'
    )
  })
})
