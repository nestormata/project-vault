import { spawnSync } from 'node:child_process'
import { createPublicKey, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HANDOFF_E2E_INSTANCE_ID,
  HANDOFF_E2E_ISSUER,
  HANDOFF_E2E_KID,
  HANDOFF_E2E_STUB_DEFAULT_PORT,
  handoffE2ePublicKeyPem,
} from '../apps/web/e2e/fixtures/handoff-test-key.js'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

/**
 * Story 66.1 AC-7: the e2e docker-compose stack contract.
 *  - scripts/e2e-stack.sh is the single place the e2e stack is started (nightly + `make e2e`), with
 *    12 per-run throwaway production secrets that must never leak (AC-2);
 *  - a readiness failure dumps `ps -a` + the migrate/admin-provision/api logs before failing (AC-4);
 *  - `make e2e SPEC=…` runs one spec, never through the broken `test:e2e -- …` form (AC-6);
 *  - the nightly e2e job's time budget and artifacts survive a slow or failing run (AC-10).
 */

type Step = {
  name?: string
  if?: unknown
  uses?: string
  run?: string
  with?: Record<string, unknown>
  shell?: string
  'timeout-minutes'?: unknown
}

type Job = { 'timeout-minutes'?: unknown; steps?: Step[]; env?: unknown }

type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> }

type Compose = {
  services?: Record<
    string,
    {
      environment?: Record<string, unknown>
      build?: { args?: Record<string, unknown> }
      ports?: unknown
    }
  >
}

const SCRIPT = 'scripts/e2e-stack.sh'
const START_STEP = 'Start the full stack (db, migrate, api, web)'
const WAIT_STEP = 'Wait for API readiness'
const PLAYWRIGHT_STEP = 'Run Playwright E2E suite'
const OK_LINE = 'e2e-stack: 12 distinct throwaway secrets OK (64 hex chars each)'
const HEX64 = /\b[0-9a-f]{64}\b/
const FIRST_SECRET = 'SESSION_SECRET'
const LATER_SECRET = 'MACHINE_JWT_SECRET'
const E2E_JOB = 'e2e'
const STUB_API_PORT = '39999'
const ADD_MASK = '::add-mask::'
const GITHUB_ACTIONS = 'GITHUB_ACTIONS'
const BASE_COMPOSE = 'docker-compose.yml'
const E2E_COMPOSE = 'docker-compose.e2e.yml'

// Read at transform time by Vite as raw text: the same lint-clean loading pattern as
// check-action-pins.test.ts (Story 64.2) and check-image-scan-workflows.test.ts (Story 64.3).
const REPO_TEXT: Record<string, string> = import.meta.glob(
  [
    '../.github/workflows/ci.yml',
    '../.github/workflows/nightly.yml',
    '../docker-compose.yml',
    '../docker-compose.e2e.yml',
    './e2e-stack.sh',
  ],
  { query: '?raw', import: 'default', eager: true }
)
// Story 60.6 AC7: production-facing config that must never carry the e2e handoff wiring.
const PROD_CONFIG_TEXT: Record<string, string> = import.meta.glob(
  ['../fly.*.toml', '../.env.example'],
  { query: '?raw', import: 'default', eager: true }
)
// `[e]` makes this a glob: vite:import-glob rejects the bare, extension-less `../Makefile` literal.
const MAKEFILE_TEXT: Record<string, string> = import.meta.glob('../Makefil[e]', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function repoText(path: string): string {
  // Vite keys a sibling of this test file as `./<name>`, everything else as `../<path>`.
  const key = path.startsWith('scripts/') ? `./${path.slice('scripts/'.length)}` : `../${path}`
  const text = Object.entries(REPO_TEXT).find(([candidate]) => candidate === key)?.[1]
  expect(text, `${path} must exist`).toBeDefined()
  return text ?? ''
}

function makefileText(): string {
  const text = Object.values(MAKEFILE_TEXT)[0]
  expect(text, 'Makefile must exist').toBeDefined()
  return text ?? ''
}

// --- AC-7.1: secret-list parity -------------------------------------------------------------

const DEV_DEFAULT_SECRET = /^\$\{([A-Z_]+):-([a-z])\2{63}\}$/

/** api.environment keys whose compose value is a `${KEY:-<64 × one letter>}` dev-only default. */
function devSecretKeysFromCompose(composeText: string): string[] {
  const compose = parseYaml(composeText, { logLevel: 'error' }) as Compose
  const environment = compose.services?.api?.environment ?? {}
  return Object.entries(environment)
    .filter(([key, value]) => {
      const match = typeof value === 'string' ? DEV_DEFAULT_SECRET.exec(value) : null
      return match !== null && match[1] === key
    })
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b))
}

/** The names in the script's `SECRET_NAMES=( … )` array. */
function scriptSecretNames(scriptText: string): string[] {
  const block = /^SECRET_NAMES=\(([^)]*)\)/m.exec(scriptText)?.[1] ?? ''
  return block
    .split(/\s+/)
    .filter((name) => /^[A-Z_]+$/.test(name))
    .sort((a, b) => a.localeCompare(b))
}

function parityProblems(composeKeys: string[], scriptNames: string[]): string[] {
  return [
    ...composeKeys
      .filter((key) => !scriptNames.includes(key))
      .map((key) => `${key}: in docker-compose.yml's api dev defaults but not in ${SCRIPT}`),
    ...scriptNames
      .filter((name) => !composeKeys.includes(name))
      .map((name) => `${name}: in ${SCRIPT} but not a docker-compose.yml api dev default`),
  ]
}

// --- AC-7.2 / 7.8 / 7.11: nightly e2e job -------------------------------------------------------

function stepNamed(job: Job, name: string): Step | undefined {
  return (job.steps ?? []).find((step) => step.name === name)
}

function scriptStepProblems(job: Job): string[] {
  const problems: string[] = []
  if (!stepNamed(job, START_STEP)?.run?.includes(`./${SCRIPT} up`)) {
    problems.push(`'${START_STEP}' must run ${SCRIPT} up`)
  }
  if (!stepNamed(job, WAIT_STEP)?.run?.includes(`./${SCRIPT} wait`)) {
    problems.push(`'${WAIT_STEP}' must run ${SCRIPT} wait`)
  }
  return problems
}

function rawStepProblems(job: Job): string[] {
  return (job.steps ?? []).flatMap((step) => {
    const label = step.name ?? '?'
    const problems: string[] = []
    if (/docker compose[^\n]*\bup\b/.test(step.run ?? '')) {
      problems.push(`step '${label}' starts the e2e stack without ${SCRIPT}`)
    }
    if (/-x\b/.test(step.shell ?? '')) problems.push(`step '${label}' runs with xtrace`)
    return problems
  })
}

function bannedReferenceProblems(job: Job): string[] {
  const jobText = JSON.stringify(job)
  return ['secrets.', 'GITHUB_ENV', 'docker compose config', 'docker inspect']
    .filter((banned) => jobText.includes(banned))
    .map((banned) => `e2e job must not reference '${banned}'`)
}

function triggerProblems(workflow: Workflow): string[] {
  const triggers = Object.keys(workflow.on ?? {})
  return ['pull_request', 'pull_request_target']
    .filter((trigger) => triggers.includes(trigger))
    .map((trigger) => `nightly.yml must not trigger on ${trigger}`)
}

function e2eJob(workflow: Workflow): Job | undefined {
  return Object.entries(workflow.jobs ?? {}).find(([key]) => key === E2E_JOB)?.[1]
}

function nightlyE2eProblems(workflowText: string): string[] {
  const workflow = parseYaml(workflowText) as Workflow
  const job = e2eJob(workflow)
  if (job === undefined) return ['nightly.yml has no e2e job']
  return [
    ...scriptStepProblems(job),
    ...rawStepProblems(job),
    ...bannedReferenceProblems(job),
    ...triggerProblems(workflow),
  ]
}

// --- AC-7.3 / 7.10: Makefile e2e recipe -----------------------------------------------------------

function makeRecipe(makefile: string, target: string): string {
  const lines = makefile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${target}:`))
  if (start === -1) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break
    body.push(line)
  }
  return body.join('\n')
}

function makeE2eProblems(makefile: string): string[] {
  const recipe = makeRecipe(makefile, E2E_JOB)
  const problems: string[] = []
  if (!recipe.includes(`./${SCRIPT} start`)) problems.push(`e2e recipe must run ./${SCRIPT} start`)
  if (/docker compose[^\n]*\bup\b/.test(recipe))
    problems.push('e2e recipe must not run a raw compose up')
  if (/test:e2e\s+--(\s|$)/.test(recipe)) problems.push('e2e recipe must not pass `--` to test:e2e')
  if (!recipe.includes('test:e2e $(if $(SPEC),"$(SPEC)")')) {
    problems.push('e2e recipe must append a quoted $(SPEC) to test:e2e')
  }
  if (/(^|[\s;&|])(source|\.)\s+\S*e2e-stack\.sh/.test(recipe)) {
    problems.push('e2e recipe must run the script as a child, never source it')
  }
  return problems
}

// --- AC-7.4 / 7.5 / 7.12: script hygiene ----------------------------------------------------------

function codeLines(scriptText: string): string[] {
  return scriptText.split('\n').filter((line) => !/^\s*#/.test(line))
}

function scriptHygieneProblems(scriptText: string, secretNames: string[]): string[] {
  const code = codeLines(scriptText)
  const problems: string[] = []
  const banned: [RegExp, string][] = [
    [/\bset\s+-[a-z]*x/, 'set -x'],
    [/\bxtrace\b/, 'xtrace'],
    [/GITHUB_ENV|GITHUB_OUTPUT/, '$GITHUB_ENV/$GITHUB_OUTPUT'],
    [/\btee\b/, 'tee'],
    [/docker compose[^\n]*\bconfig\b/, 'docker compose config'],
    [/docker inspect/, 'docker inspect'],
    [/\bprintenv\b/, 'printenv'],
    [/--build-arg/, '--build-arg'],
  ]
  for (const [pattern, label] of banned) {
    if (code.some((line) => pattern.test(line))) problems.push(`script must not use ${label}`)
  }
  const expandsSecret = (line: string) =>
    line.includes('${!') ||
    secretNames.some((name) => line.includes(`$${name}`) || line.includes(`\${${name}`))
  const printing = code
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /\b(echo|printf)\b/.test(line) && expandsSecret(line))
  const allowed = printing.filter(
    ({ line, index }) => line.includes(ADD_MASK) && (code[index - 1] ?? '').includes(GITHUB_ACTIONS)
  )
  for (const { line } of printing) {
    if (!allowed.some((entry) => entry.line === line)) {
      problems.push(`script prints a secret value: ${line.trim()}`)
    }
  }
  if (allowed.length !== 1) problems.push('exactly one GITHUB_ACTIONS-guarded ::add-mask:: line')
  return problems
}

function runScript(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  }
  return spawnSync('bash', [SCRIPT, ...args], { env: { ...base, ...env }, encoding: 'utf8' })
}

function hex64(): string {
  return randomBytes(32).toString('hex')
}

// A fake `docker`/`curl` on PATH so the wait/dump failure path runs without a docker daemon. The
// stub `docker compose ps --format` answers from $STUB_PS; `ps -a` and `logs` print marker lines.
const WAIT_HARNESS = `
set -euo pipefail
stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT
cat > "$stub/docker" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"ps --all --format"*|*"ps -a --format"*) printf '%s\\n' "\${STUB_PS:-}" ;;
  *"ps -a"*) echo "STUB-PS-A" ;;
  *"logs --no-color --tail=200 migrate admin-provision api"*) echo "STUB-LOGS token=\${SESSION_SECRET:-none}" ;;
  *) echo "STUB-OTHER $*" ;;
esac
STUB
cat > "$stub/curl" <<'STUB'
#!/usr/bin/env bash
exit "\${STUB_CURL_EXIT:-7}"
STUB
chmod +x "$stub/docker" "$stub/curl"
PATH="$stub:$PATH" bash scripts/e2e-stack.sh wait
`

function runWait(env: Record<string, string>) {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    API_HOST_PORT: STUB_API_PORT,
    E2E_HEALTH_ATTEMPTS: '2',
    E2E_HEALTH_INTERVAL_SECONDS: '0',
  }
  return spawnSync('bash', ['-c', WAIT_HARNESS], { env: { ...base, ...env }, encoding: 'utf8' })
}

const SECRET_NAMES_FROM_SCRIPT = () => scriptSecretNames(repoText(SCRIPT))

describe('Story 66.1 AC-7.1: the script generates exactly the compose dev-default secrets', () => {
  it('matches the 12 api dev-default secrets in docker-compose.yml', () => {
    const composeKeys = devSecretKeysFromCompose(repoText(BASE_COMPOSE))
    expect(composeKeys).toHaveLength(12)
    expect(parityProblems(composeKeys, SECRET_NAMES_FROM_SCRIPT())).toEqual([])
  })

  it('reports a 13th compose dev-default secret missing from the script, by name', () => {
    const fixture = `services:\n  api:\n    environment:\n      NEW_HMAC_SECRET: \${NEW_HMAC_SECRET:-${'m'.repeat(64)}}\n      LOG_LEVEL: info\n`
    const keys = devSecretKeysFromCompose(fixture)
    expect(keys).toEqual(['NEW_HMAC_SECRET'])
    expect(parityProblems(keys, SECRET_NAMES_FROM_SCRIPT())).toContain(
      `NEW_HMAC_SECRET: in docker-compose.yml's api dev defaults but not in ${SCRIPT}`
    )
  })
})

describe('Story 66.1 AC-7.2/7.8/7.11: nightly e2e job', () => {
  const nightly = () => repoText('.github/workflows/nightly.yml')

  it('starts and waits on the stack only through the script, with no secrets or env dumps', () => {
    expect(nightlyE2eProblems(nightly())).toEqual([])
  })

  it('rejects a raw docker compose up in the e2e job', () => {
    const fixture = nightly().replace(
      `./${SCRIPT} up`,
      'docker compose -f docker-compose.yml up -d'
    )
    expect(nightlyE2eProblems(fixture).join('\n')).toMatch(/without scripts\/e2e-stack\.sh/)
  })

  it('rejects a secrets.* reference in the e2e job', () => {
    const fixture = nightly().replace(
      `run: ./${SCRIPT} wait`,
      `run: ./${SCRIPT} wait \${{ secrets.X }}`
    )
    expect(nightlyE2eProblems(fixture)).toContain("e2e job must not reference 'secrets.'")
  })

  it('rejects a pull_request trigger', () => {
    const fixture = nightly().replace(
      '  workflow_dispatch:\n',
      '  workflow_dispatch:\n  pull_request:\n'
    )
    expect(nightlyE2eProblems(fixture)).toContain('nightly.yml must not trigger on pull_request')
  })

  it('has a 45-minute job, 15/25-minute step timeouts and a run_attempt-named artifact on failure or cancel', () => {
    const workflow = parseYaml(nightly()) as Workflow
    const job = e2eJob(workflow) ?? {}
    expect(job['timeout-minutes']).toBe(45)
    expect(stepNamed(job, START_STEP)?.['timeout-minutes']).toBe(15)
    expect(stepNamed(job, PLAYWRIGHT_STEP)?.['timeout-minutes']).toBe(25)
    const upload = (job.steps ?? []).find((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    )
    expect(upload?.if).toBe('failure() || cancelled()')
    expect(String(upload?.with?.name)).toContain('github.run_attempt')
  })
})

describe('Story 66.1 AC-7.3/7.10: Makefile e2e recipe', () => {
  it('starts the stack through the script and appends $(SPEC) without --', () => {
    expect(makeE2eProblems(makefileText())).toEqual([])
  })

  it('rejects the broken `test:e2e -- $(SPEC)` form', () => {
    const fixture = makefileText().replace(
      'test:e2e $(if $(SPEC),"$(SPEC)")',
      'test:e2e -- $(SPEC)'
    )
    expect(makeE2eProblems(fixture)).toContain('e2e recipe must not pass `--` to test:e2e')
  })

  it('rejects sourcing the script into the recipe shell', () => {
    const fixture = makefileText().replace(`./${SCRIPT} start`, `. ./${SCRIPT} start`)
    expect(makeE2eProblems(fixture)).toContain(
      'e2e recipe must run the script as a child, never source it'
    )
  })

  it('is wired into both make ci and ci.yml', () => {
    expect(makeRecipe(makefileText(), 'ci-inner')).toContain('scripts/e2e-stack.test.ts')
    const ci = parseYaml(repoText('.github/workflows/ci.yml')) as Workflow
    const runs = Object.values(ci.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((s) => s.run))
    expect(runs).toContain('pnpm vitest run scripts/e2e-stack.test.ts')
  })
})

describe('Story 66.1 AC-7.4/7.5/7.12: script hygiene', () => {
  it('never traces, tees, dumps resolved env or prints a secret outside the one add-mask line', () => {
    expect(scriptHygieneProblems(repoText(SCRIPT), SECRET_NAMES_FROM_SCRIPT())).toEqual([])
  })

  it('flags an echo of a secret', () => {
    const fixture = `${repoText(SCRIPT)}\necho "$SESSION_SECRET"\n`
    expect(scriptHygieneProblems(fixture, SECRET_NAMES_FROM_SCRIPT())).toContain(
      'script prints a secret value: echo "$SESSION_SECRET"'
    )
  })

  it('flags set -x', () => {
    const fixture = `${repoText(SCRIPT)}\nset -x\n`
    expect(scriptHygieneProblems(fixture, SECRET_NAMES_FROM_SCRIPT())).toContain(
      'script must not use set -x'
    )
  })

  it('dumps ps -a and the migrate/admin-provision/api logs on failure', () => {
    const code = codeLines(repoText(SCRIPT)).join('\n')
    expect(code).toMatch(/ps -a\b/)
    expect(code).toContain('logs --no-color --tail=200 migrate admin-provision api')
  })
})

describe('Story 66.1 AC-7.6: self-test (no docker)', () => {
  it('generates 12 distinct values and prints no value', () => {
    const run = runScript(['self-test'])
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(OK_LINE)
    expect(run.stdout).not.toMatch(HEX64)
    expect(run.stderr).not.toMatch(HEX64)
  })

  it('keeps a valid caller-provided value and names it without printing it', () => {
    const preset = hex64()
    const run = runScript(['self-test'], { [FIRST_SECRET]: preset })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(`e2e-stack: using caller-provided ${FIRST_SECRET}`)
    expect(`${run.stdout}${run.stderr}`).not.toContain(preset)
  })

  it('fails fast on a caller-provided dev literal, naming the key', () => {
    const run = runScript(['self-test'], { [FIRST_SECRET]: 'a'.repeat(64) })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      `e2e-stack: ${FIRST_SECRET} is a known dev literal; unset it or supply a real throwaway`
    )
    expect(run.stderr).not.toContain('a'.repeat(64))
  })

  it('fails fast on two caller-provided duplicates, naming both keys', () => {
    const value = hex64()
    const run = runScript(['self-test'], { [FIRST_SECRET]: value, [LATER_SECRET]: value })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`e2e-stack: ${LATER_SECRET} duplicates ${FIRST_SECRET}`)
    expect(`${run.stdout}${run.stderr}`).not.toContain(value)
  })

  it('emits ::add-mask:: lines only under GITHUB_ACTIONS=true', () => {
    const plain = runScript(['self-test'])
    expect(plain.stdout).not.toContain(ADD_MASK)
    const ci = runScript(['self-test'], { [GITHUB_ACTIONS]: 'true' })
    expect(ci.status, ci.stderr).toBe(0)
    const masks = ci.stdout.split('\n').filter((line) => line.startsWith(ADD_MASK))
    expect(masks).toHaveLength(12)
    expect(ci.stdout.indexOf(ADD_MASK)).toBe(0)
  })

  it('rejects an unknown subcommand', () => {
    const run = runScript(['bogus'])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('usage')
  })
})

describe('Story 66.1 AC-4: readiness failure dump (stubbed docker/curl)', () => {
  it('prints ps -a, then the logs, then the final line, and exits 1 after the budget', () => {
    const run = runWait({ STUB_PS: 'db running 0\napi running 0' })
    expect(run.status).toBe(1)
    const err = run.stderr
    const final = `e2e-stack: API never became ready on http://localhost:${STUB_API_PORT}/health after`
    expect(err).toContain('STUB-PS-A')
    expect(err).toContain('STUB-LOGS')
    expect(err.indexOf('STUB-PS-A')).toBeLessThan(err.indexOf('STUB-LOGS'))
    expect(err.indexOf('STUB-LOGS')).toBeLessThan(err.indexOf(final))
    expect(err.trimEnd().split('\n').at(-1)).toMatch(/after \d+s \(last curl exit 7\)$/)
  })

  it('keeps each dump header next to its own output (headers go through the same pipe)', () => {
    for (let round = 0; round < 5; round++) {
      const err = runWait({ STUB_PS: 'db running 0\napi running 0' }).stderr
      const order = [
        'e2e-stack: container status (docker compose ps -a):',
        'STUB-PS-A',
        'e2e-stack: recent logs (migrate, admin-provision, api):',
        'STUB-LOGS',
      ].map((marker) => err.indexOf(marker))
      expect(order.every((position) => position >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    }
  })

  it('accepts a zero-padded attempt budget instead of dying on bash octal arithmetic', () => {
    const run = runWait({ STUB_PS: 'api running 0', E2E_HEALTH_ATTEMPTS: '08' })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/API never became ready on .* \(last curl exit 7\)\n?$/)
  })

  it('fails fast when the api container has exited, without burning the budget', () => {
    const run = runWait({ STUB_PS: 'migrate exited 0\napi exited 1', E2E_HEALTH_ATTEMPTS: '50' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('e2e-stack: container exited: api (exit 1)')
    expect(run.stderr).toContain('STUB-LOGS')
  })

  it('redacts a secret value that reaches the dump', () => {
    const value = hex64()
    const run = runWait({ STUB_PS: 'api exited 1', [FIRST_SECRET]: value })
    expect(run.stderr).toContain('STUB-LOGS token=***')
    expect(run.stderr).not.toContain(value)
  })

  it('reports a non-retryable curl exit in the final line', () => {
    const run = runWait({ STUB_PS: 'api running 0', STUB_CURL_EXIT: '22' })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/\(last curl exit 22\)\n?$/)
  })
})

describe('Story 66.1 AC-7.7/7.9: compose files', () => {
  it('resets the mailpit host ports in the e2e override only', () => {
    const lines = codeLines(repoText(E2E_COMPOSE))
    const mailpit = lines.indexOf('  mailpit:')
    expect(mailpit).toBeGreaterThan(-1)
    expect(lines[mailpit + 1]).toBe('    ports: !reset []')
    expect(repoText(BASE_COMPOSE)).not.toContain('!reset')
  })

  it('keeps the 12 base compose dev-default secret lines verbatim', () => {
    const base = repoText(BASE_COMPOSE)
    const names = [
      'SESSION_SECRET',
      'REFRESH_TOKEN_HMAC_SECRET',
      'TOTP_REPLAY_HMAC_SECRET',
      'MFA_PENDING_SESSION_HMAC_SECRET',
      'INVITATION_TOKEN_HMAC_SECRET',
      'RECOVERY_TOKEN_HMAC_SECRET',
      'API_KEY_HMAC_SECRET',
      'MACHINE_JWT_SECRET',
      'STATUS_PAGE_TOKEN_HMAC_SECRET',
      'ERASURE_EMAIL_HASH_SECRET',
      'SSO_STATE_HMAC_SECRET',
      'OPERATIONAL_STATUS_TOKEN_HMAC_SECRET',
    ]
    names.forEach((name, index) => {
      const letter = String.fromCodePoint(97 + index)
      expect(base).toContain(`      ${name}: \${${name}:-${letter.repeat(64)}}\n`)
    })
  })

  it('keeps NODE_ENV out of the e2e override and limits api build args to the mock-SSO flag', () => {
    const text = repoText(E2E_COMPOSE)
    expect(codeLines(text).join('\n')).not.toContain('NODE_ENV')
    const compose = parseYaml(text, { logLevel: 'error' }) as Compose
    expect(Object.keys(compose.services?.api?.build?.args ?? {})).toEqual([
      'INCLUDE_MOCK_SSO_EXTENSION',
    ])
  })
})

// --- Story 60.6 AC7: the e2e-only handoff wiring ----------------------------------------------

type HandoffVerifyKey = { kid?: unknown; publicKeyPem?: unknown }

function e2eServiceEnv(service: 'api' | 'web'): Record<string, unknown> {
  const compose = parseYaml(repoText(E2E_COMPOSE), { logLevel: 'error' }) as Compose
  const entry = service === 'api' ? compose.services?.api : compose.services?.web
  return entry?.environment ?? {}
}

function parseVerifyKeys(raw: unknown): HandoffVerifyKey[] {
  expect(typeof raw, 'VAULT_HANDOFF_VERIFY_KEYS must be a string').toBe('string')
  const parsed = JSON.parse(String(raw)) as unknown
  expect(Array.isArray(parsed), 'VAULT_HANDOFF_VERIFY_KEYS must be a JSON array').toBe(true)
  return parsed as HandoffVerifyKey[]
}

/** Production-facing files that must never carry the e2e key, instance id or stub port. */
function productionConfigTexts(): Array<[string, string]> {
  const flyFiles = Object.entries(PROD_CONFIG_TEXT).filter(([path]) =>
    /\/fly\.[^/]*\.toml$/.test(path)
  )
  expect(flyFiles.length, 'expected at least fly.api.toml and fly.web.toml').toBeGreaterThanOrEqual(
    2
  )
  const example = Object.entries(PROD_CONFIG_TEXT).find(([path]) => path.endsWith('.example'))
  expect(example, 'the example env file must be loaded').toBeDefined()
  return [[BASE_COMPOSE, repoText(BASE_COMPOSE)], ...flyFiles, ...(example ? [example] : [])]
}

describe('Story 60.6 AC7: e2e-only handoff wiring', () => {
  it('enables handoff on the e2e api with the test-only instance id and a pinned issuer', () => {
    const api = e2eServiceEnv('api')
    expect(api['VAULT_HANDOFF_ENABLED']).toBe('true')
    expect(api['VAULT_HANDOFF_INSTANCE_ID']).toBe(HANDOFF_E2E_INSTANCE_ID)
    // A literal, never `${VAULT_HANDOFF_ISSUER:-…}`: a stray shell value must not change `iss`.
    expect(api['VAULT_HANDOFF_ISSUER']).toBe(HANDOFF_E2E_ISSUER)
  })

  it('trusts exactly one ed25519 key: the kid and public key derived from the fixture seed', () => {
    const keys = parseVerifyKeys(e2eServiceEnv('api')['VAULT_HANDOFF_VERIFY_KEYS'])
    expect(keys).toHaveLength(1)
    const [key] = keys
    expect(key?.kid).toBe(HANDOFF_E2E_KID)
    const publicKey = createPublicKey(String(key?.publicKeyPem))
    expect(publicKey.asymmetricKeyType).toBe('ed25519')
    expect(key?.publicKeyPem).toBe(handoffE2ePublicKeyPem())
  })

  it('allowlists PV itself and the stub origin on the web, with handoff enabled and an empty issuer', () => {
    const web = e2eServiceEnv('web')
    expect(web['VAULT_HANDOFF_ENABLED']).toBe('true')
    expect(web['CORS_ALLOWED_ORIGINS']).toBe(
      '${PUBLIC_WEB_ORIGIN:-http://localhost:${WEB_HOST_PORT:-5173}},' +
        `http://127.0.0.1:\${E2E_HANDOFF_STUB_PORT:-${HANDOFF_E2E_STUB_DEFAULT_PORT}}`
    )
    // j28's 60.4 tests assert the plain-text guidance an unset web issuer produces. Pinned empty,
    // not omitted: the base file's `${VAULT_HANDOFF_ISSUER:-}` would otherwise pick up the
    // worktree's local config (created from the example file, which sets it) and render a link.
    expect(web['VAULT_HANDOFF_ISSUER']).toBe('')
  })

  it('pins the fixture defaults to the override (stub port, issuer, instance id, kid)', () => {
    expect(HANDOFF_E2E_STUB_DEFAULT_PORT).toBe(48999)
    expect(HANDOFF_E2E_ISSUER).toBe('https://app.centralizeme.com')
    expect(HANDOFF_E2E_INSTANCE_ID).toBe('pv-e2e')
    expect(HANDOFF_E2E_KID).toBe('pv-e2e-test-only-1')
    expect(repoText(E2E_COMPOSE)).toContain(
      `E2E_HANDOFF_STUB_PORT:-${HANDOFF_E2E_STUB_DEFAULT_PORT}`
    )
  })

  it('keeps the e2e key, instance id and stub port out of every production-facing config', () => {
    // The public key's base64 body too, so it can't be copied in under a different kid.
    const publicKeyBody = handoffE2ePublicKeyPem()
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s/g, '')
    const markers = [
      HANDOFF_E2E_KID,
      HANDOFF_E2E_INSTANCE_ID,
      'E2E_HANDOFF_STUB_PORT',
      publicKeyBody,
    ]
    for (const [path, text] of productionConfigTexts()) {
      for (const marker of markers) {
        expect(text, `${path} must not contain ${marker}`).not.toContain(marker)
      }
    }
    expect(repoText(BASE_COMPOSE)).not.toContain('VAULT_HANDOFF_ENABLED')
  })
})
