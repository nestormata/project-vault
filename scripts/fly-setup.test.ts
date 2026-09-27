import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './lib/fixture-test-helpers.js'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'

// Story 43.9 AC-13: scripts/fly-setup.sh must require VAULT_APP_PASSWORD instead of silently
// wiring the api to the migration's publicly known default vault_app password.
//
// The script runs under bash with a stub `flyctl` first on the child's PATH that records every
// invocation. The stub is test scaffolding only; the product never resolves binaries this way.

const SCRIPT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fly-setup.sh')
const BASH = resolveTrustedExecutable('bash')

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runFlySetup(extraEnv: Record<string, string>): {
  status: number | null
  stderr: string
  flyctlCalls: string[]
} {
  const root = mkdtempSync(join(tmpdir(), 'fly-setup-'))
  tempRoots.push(root)
  const log = join(root, 'flyctl-calls.log')
  writeFixture(root, 'bin/flyctl', '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FLY_STUB_LOG"\nexit 0\n')
  chmodSync(join(root, 'bin/flyctl'), 0o755)
  const result = spawnSync(BASH, [SCRIPT], {
    encoding: 'utf8',
    // A fixed environment, so a developer's own exported Fly variables never leak in.
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: root,
      FLY_STUB_LOG: log,
      FLY_ORG: 'test-org',
      VAULT_ADMIN_PASSWORD: 'admin-test-value',
      ...extraEnv,
    },
  })
  const flyctlCalls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { status: result.status, stderr: result.stderr, flyctlCalls }
}

describe('fly-setup.sh VAULT_APP_PASSWORD (Story 43.9 AC-13)', () => {
  it('unset: exits non-zero before any flyctl call, naming the variable', () => {
    const { status, stderr, flyctlCalls } = runFlySetup({})
    expect(status).not.toBe(0)
    expect(stderr).toContain('Set VAULT_APP_PASSWORD')
    expect(flyctlCalls).toEqual([])
  })

  it('empty: fails the same way (`:?` treats empty as unset)', () => {
    const { status, stderr, flyctlCalls } = runFlySetup({ VAULT_APP_PASSWORD: '' })
    expect(status).not.toBe(0)
    expect(stderr).toContain('Set VAULT_APP_PASSWORD')
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
