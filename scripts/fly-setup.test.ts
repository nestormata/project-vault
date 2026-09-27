import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
const FLYCTL_STUB = `() { printf '%s\\n' "$*" >&${FLYCTL_CALL_FD}; }`

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
    DEMO_LOGIN_EMAIL: 'demo@example.com',
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
