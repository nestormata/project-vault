import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'

// Story 43.9 AC-13: scripts/fly-setup.sh must require VAULT_APP_PASSWORD instead of silently
// wiring the api to the migration's publicly known default vault_app password.
//
// The script runs under bash with `flyctl` stubbed as an exported bash function (imported from the
// child's environment, so it shadows any real flyctl and satisfies `command -v`) that records every
// invocation on file descriptor 3 — a pipe the test reads back, so nothing is written to disk and a
// `2>/dev/null` or `| grep` around a call in the script cannot swallow the record. The stub is test
// scaffolding only; the product never resolves binaries this way.

const SCRIPTS_DIR = import.meta.dirname
const SCRIPT = resolve(SCRIPTS_DIR, 'fly-setup.sh')
const RESET_SCRIPT = resolve(SCRIPTS_DIR, 'fly-reset.sh')
const MISSING_APP_PASSWORD = 'Set VAULT_APP_PASSWORD'
const BASH = resolveTrustedExecutable('bash')
// Bash imports `BASH_FUNC_<name>%%` environment entries as exported functions.
const FLYCTL_STUB_ENV = 'BASH_FUNC_flyctl%%'
const FLYCTL_CALL_FD = 3
// Story 43.16: `secrets import` (used to stage the internal TLS secrets without putting them on
// argv) reads NAME=VALUE lines on stdin; the stub records those too, prefixed with `STDIN `.
const FLYCTL_STUB = [
  '() {',
  `  printf '%s\\n' "$*" >&${FLYCTL_CALL_FD}`,
  '  if [[ "$1" == secrets && "$2" == import ]]; then',
  '    local line',
  `    while IFS= read -r line; do printf 'STDIN %s\\n' "$line" >&${FLYCTL_CALL_FD}; done`,
  '  fi',
  '}',
].join('\n')

// Story 43.16: fly-setup.sh now issues the internal TLS leaves from the GitHub-held CA, so every
// run needs one. A throwaway CA is minted once with the real script and read back through openssl.
const TLS_SCRIPT = resolve(SCRIPTS_DIR, 'fly-internal-tls.sh')
const OPENSSL = resolveTrustedExecutable('openssl')
let caRoot: string
let caEnv: Record<string, string>

beforeAll(() => {
  caRoot = mkdtempSync(join(tmpdir(), 'fly-setup-ca-'))
  const caDir = join(caRoot, 'ca')
  execFileSync(BASH, [TLS_SCRIPT, 'init-ca', '--out', caDir], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
  })
  const b64 = (name: string) =>
    execFileSync(OPENSSL, ['base64', '-A', '-in', join(caDir, name)], { encoding: 'utf8' }).trim()
  caEnv = { FLY_INTERNAL_CA_CERT_B64: b64('ca.crt'), FLY_INTERNAL_CA_KEY_B64: b64('ca.key') }
})

afterAll(() => {
  rmSync(caRoot, { recursive: true, force: true })
})

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runFlyScript(
  script: string,
  extraEnv: Record<string, string>
): {
  status: number | null
  stderr: string
  flyctlCalls: string[]
} {
  const root = mkdtempSync(join(tmpdir(), 'fly-setup-'))
  tempRoots.push(root)
  const result = spawnSync(BASH, [script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    // A fixed environment, so a developer's own exported Fly variables never leak in.
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      [FLYCTL_STUB_ENV]: FLYCTL_STUB,
      FLY_ORG: 'test-org',
      VAULT_ADMIN_PASSWORD: 'admin-test-value',
      ...caEnv,
      ...extraEnv,
    },
  })
  const flyctlCalls = String(result.output.at(FLYCTL_CALL_FD) ?? '')
    .split('\n')
    .filter(Boolean)
  return { status: result.status, stderr: result.stderr, flyctlCalls }
}

function runFlySetup(extraEnv: Record<string, string>) {
  return runFlyScript(SCRIPT, extraEnv)
}

describe('fly-setup.sh VAULT_APP_PASSWORD (Story 43.9 AC-13)', () => {
  it('unset: exits non-zero before any flyctl call, naming the variable', () => {
    const { status, stderr, flyctlCalls } = runFlySetup({})
    expect(status).not.toBe(0)
    expect(stderr).toContain(MISSING_APP_PASSWORD)
    expect(flyctlCalls).toEqual([])
  })

  it('empty: fails the same way (`:?` treats empty as unset)', () => {
    const { status, stderr, flyctlCalls } = runFlySetup({ VAULT_APP_PASSWORD: '' })
    expect(status).not.toBe(0)
    expect(stderr).toContain(MISSING_APP_PASSWORD)
    expect(flyctlCalls).toEqual([])
  })

  it('set: the api DATABASE_URL secret uses exactly that password', () => {
    const { status, flyctlCalls } = runFlySetup({ VAULT_APP_PASSWORD: 's3cret' })
    expect(status).toBe(0)
    const apiSecrets = flyctlCalls.find((call) =>
      call.startsWith('secrets set -a project-vault-demo-api')
    )
    expect(apiSecrets).toContain('DATABASE_URL=postgresql://vault_app:s3cret@')
    expect(flyctlCalls.join('\n')).not.toContain('dev-only-change-in-prod')
  })
})

// fly-reset.sh ALTERs vault_app to VAULT_APP_PASSWORD after every migrate run. A silent fallback
// there to the migration's publicly known default would both break the api (its DATABASE_URL,
// set by fly-setup.sh, carries the real password) and re-arm that public password on the demo DB.
describe('fly-reset.sh VAULT_APP_PASSWORD (Story 43.9 AC-13 consistency)', () => {
  const RESET_ENV = {
    ADMIN_PG_PASSWORD: 'pg-test-value',
    DEMO_VAULT_PASSPHRASE: 'passphrase-test-value',
    // Only presence is checked before the VAULT_APP_PASSWORD guard, so any non-empty value will do.
    DEMO_LOGIN_EMAIL: 'demo-login-email-test-value',
    DEMO_LOGIN_PASSWORD: 'demo-test-value',
    VAULT_BOOTSTRAP_TOKEN: 'bootstrap-test-value',
  }

  it.each([
    ['unset', {}],
    ['empty', { VAULT_APP_PASSWORD: '' }],
  ])('%s: exits non-zero before any flyctl call, naming the variable', (_label, appPassword) => {
    const { status, stderr, flyctlCalls } = runFlyScript(RESET_SCRIPT, {
      ...RESET_ENV,
      ...appPassword,
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain(MISSING_APP_PASSWORD)
    expect(flyctlCalls).toEqual([])
  })
})

// Story 43.16 AC-5: fly-setup.sh issues the internal PKI and wires every URL to TLS.
describe('fly-setup.sh internal TLS (Story 43.16 AC-5)', () => {
  const API_APP = 'project-vault-demo-api'
  const WEB_APP = 'project-vault-demo-web'
  const DB_APP = 'project-vault-demo-db'
  const TLS_SECRETS: Record<string, string[]> = {
    [API_APP]: [
      'API_TLS_CERT_B64',
      'API_TLS_CLIENT_CA_B64',
      'API_TLS_KEY_B64',
      'DATABASE_TLS_CA_B64',
      'DATABASE_TLS_CLIENT_CERT_B64',
      'DATABASE_TLS_CLIENT_KEY_B64',
    ],
    [WEB_APP]: ['API_TLS_CA_B64', 'API_TLS_CLIENT_CERT_B64', 'API_TLS_CLIENT_KEY_B64'],
    [DB_APP]: ['DB_TLS_CERT_B64', 'DB_TLS_CLIENT_CA_B64', 'DB_TLS_KEY_B64'],
  }

  function stagedNamesByApp(calls: string[]): Map<string, string[]> {
    const staged = new Map<string, string[]>()
    let app: string | undefined
    for (const call of calls) {
      if (call.startsWith('STDIN ')) {
        if (app) staged.get(app)?.push(call.slice('STDIN '.length).split('=')[0] ?? '')
        continue
      }
      app = /^secrets import --stage -a (\S+)/.exec(call)?.[1]
      if (app && !staged.has(app)) staged.set(app, [])
    }
    return staged
  }

  it('missing FLY_INTERNAL_CA_CERT_B64: exits non-zero before any flyctl call, naming it', () => {
    const { status, stderr, flyctlCalls } = runFlySetup({
      VAULT_APP_PASSWORD: 's3cret',
      FLY_INTERNAL_CA_CERT_B64: '',
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain('FLY_INTERNAL_CA_CERT_B64')
    expect(flyctlCalls).toEqual([])
  })

  it('wires API_BASE_URL to https and both DB URLs to sslmode=verify-full', () => {
    const { status, flyctlCalls } = runFlySetup({ VAULT_APP_PASSWORD: 's3cret' })
    expect(status).toBe(0)
    const webSecrets = flyctlCalls.find((call) => call.startsWith(`secrets set -a ${WEB_APP}`))
    expect(webSecrets).toContain(`API_BASE_URL=https://${API_APP}.internal:3000`)
    const apiSecrets = flyctlCalls.find((call) => call.startsWith(`secrets set -a ${API_APP}`))
    expect(apiSecrets).toMatch(
      new RegExp(
        `DATABASE_URL=postgresql://vault_app:s3cret@${DB_APP}\\.internal:5432/project_vault\\?sslmode=verify-full( |$)`
      )
    )
    expect(apiSecrets).toMatch(
      new RegExp(
        `ADMIN_DATABASE_URL=postgresql://vault_admin:admin-test-value@${DB_APP}\\.internal:5432/project_vault\\?sslmode=verify-full( |$)`
      )
    )
    expect(flyctlCalls.join('\n')).not.toMatch(/http:\/\/[^ ]*\.internal/)
  })

  it('stages each of the twelve TLS secrets to the right app and none to the wrong one', () => {
    const { status, flyctlCalls } = runFlySetup({ VAULT_APP_PASSWORD: 's3cret' })
    expect(status).toBe(0)
    const staged = stagedNamesByApp(flyctlCalls)
    for (const [app, names] of Object.entries(TLS_SECRETS)) {
      expect([...(staged.get(app) ?? [])].sort()).toEqual(names)
    }
    expect([...staged.keys()].sort()).toEqual([API_APP, DB_APP, WEB_APP])
    // e.g. the api's private key never reaches the web app
    expect(staged.get(WEB_APP)).not.toContain('API_TLS_KEY_B64')
  })

  it('stages the db TLS secrets before the db deploy, which builds the TLS image remotely', () => {
    const { flyctlCalls } = runFlySetup({ VAULT_APP_PASSWORD: 's3cret' })
    const stageDb = flyctlCalls.findIndex((call) =>
      call.startsWith(`secrets import --stage -a ${DB_APP}`)
    )
    const deployDb = flyctlCalls.findIndex((call) => call.startsWith('deploy -c fly.db.toml'))
    expect(stageDb).toBeGreaterThan(-1)
    expect(deployDb).toBeGreaterThan(stageDb)
    expect(flyctlCalls.at(deployDb)).toContain('--remote-only')
  })
})

// Story 43.16 Decision 6: the operator path needs the CA to mint its per-run client certificate,
// so both operator scripts fail closed without it — before any flyctl call.
describe('fly-migrate.sh / fly-reset.sh internal CA (Story 43.16)', () => {
  const MIGRATE_SCRIPT = resolve(SCRIPTS_DIR, 'fly-migrate.sh')
  const COMMON = {
    ADMIN_PG_PASSWORD: 'pg-test-value',
    VAULT_APP_PASSWORD: 'app-test-value',
    FLY_INTERNAL_CA_CERT_B64: '',
    FLY_INTERNAL_CA_KEY_B64: '',
  }

  it.each([
    ['fly-migrate.sh', MIGRATE_SCRIPT, {}],
    [
      'fly-reset.sh',
      RESET_SCRIPT,
      {
        DEMO_VAULT_PASSPHRASE: 'passphrase-test-value',
        DEMO_LOGIN_EMAIL: 'demo-login-email-test-value',
        DEMO_LOGIN_PASSWORD: 'demo-test-value',
        VAULT_BOOTSTRAP_TOKEN: 'bootstrap-test-value',
      },
    ],
  ])('%s without FLY_INTERNAL_CA_CERT_B64 exits before any flyctl call', (_name, script, extra) => {
    const { status, stderr, flyctlCalls } = runFlyScript(script, { ...COMMON, ...extra })
    expect(status).not.toBe(0)
    expect(stderr).toContain('FLY_INTERNAL_CA_CERT_B64')
    expect(flyctlCalls).toEqual([])
  })
})
