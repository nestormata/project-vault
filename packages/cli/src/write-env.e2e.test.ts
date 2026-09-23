/**
 * Story 43.5 Task 8 — end-to-end through the real commander wiring (`buildProgram().parseAsync`)
 * with a real temp directory and a fake `createVaultAgent` (no live API: `get-command.e2e.test.ts`
 * already covers the real fetch path, and its local fixture has a pre-existing, unrelated failure).
 *
 * AC-4/AC-5: across the success path and EVERY failure exit code, neither stdout nor stderr may
 * contain any fetched value or any non-empty line of a multi-line value — the CLI's equivalent of
 * vault-action's per-line masking.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultAgentError } from '@project-vault/agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildProgram } from './cli.js'
import { ENV_FILE_HEADER } from './env-file-format.js'
import { EXIT_CODES } from './exit-codes.js'

const isWindows = process.platform === 'win32'
/** Every failure case below fetches this multi-line value first, so an abort-path leak of an
 * already-fetched value would be caught by the per-line output check. */
const FETCHED_FIRST = 'stripe-key=S'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const VALUES: Record<string, string> = {
  DATABASE_URL: 'postgres://user:hunter2-db@host/db',
  'stripe-key': 'sk_live_first-line\nsk_live_second-line\n',
  UNREPRESENTABLE: `quote' tick\` dq" UNREP-SECRET`,
}
const NON_EMPTY_LINES = Object.values(VALUES)
  .flatMap((value) => value.split('\n'))
  .filter((line) => line.length > 0)

const AGENT_ERRORS: Record<string, string> = {
  MISSING: 'credential_not_found',
  FORBIDDEN: 'insufficient_role',
  MULTI: 'multi_field_secret_unsupported',
  THROTTLED: 'vault_request_failed',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pvault-write-env-e2e-'))
})
afterEach(() => {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

function snapshot(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(path)) {
    const full = join(path, name)
    out[name] = statSync(full).isFile() ? readFileSync(full, 'utf8') : '<dir>'
  }
  return out
}

async function pvault(...args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  let exitCode: number | undefined
  const program = buildProgram({
    streams: {
      stdout: { write: (c: string) => void stdout.push(c) },
      stderr: { write: (c: string) => void stderr.push(c) },
      isTTY: false,
    },
    env: {
      VAULT_API_KEY: 'pk_e2e',
      VAULT_URL: 'https://vault.example.com',
      VAULT_PROJECT_ID: 'a1c2d3e4-0000-0000-0000-000000000000',
    },
    createVaultAgent: () =>
      ({
        getSecret: async (name: string) => {
          const code = AGENT_ERRORS[name]
          if (code) throw new VaultAgentError(code, 'server said no')
          if (name === 'BOOM') throw new Error('socket hang up')
          const value = VALUES[name]
          if (value === undefined) throw new VaultAgentError('credential_not_found', 'nope')
          return value
        },
      }) as never,
    setExitCode: (code) => {
      exitCode = code
    },
    prompt: () => {
      throw new Error('unused')
    },
    fetchFn: (() => {
      throw new Error('unused')
    }) as never,
    spawn: (() => {
      throw new Error('unused')
    }) as never,
    parentProcess: {
      pid: 1,
      platform: 'linux',
      on: () => {},
      removeListener: () => {},
      kill: () => {},
    },
    cwd: dir,
    checkGitIgnored: async () => 'unknown',
  })
  await program.parseAsync(['node', 'pvault', 'write-env', ...args])
  const output = stdout.join('') + stderr.join('')
  for (const line of NON_EMPTY_LINES) expect(output).not.toContain(line)
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('pvault write-env — end to end', () => {
  it('success: exact file bytes, mode 0600, one stderr line, empty stdout, no value in output', async () => {
    const result = await pvault(
      '--secret',
      'DATABASE_URL',
      '--secret',
      'stripe-key=STRIPE_KEY',
      '--output',
      '.env'
    )
    const path = join(dir, '.env')
    expect(result).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: `Wrote 2 secrets to ${path}\n`,
    })
    expect(readFileSync(path, 'utf8')).toBe(
      `${ENV_FILE_HEADER}DATABASE_URL='postgres://user:hunter2-db@host/db'\nSTRIPE_KEY='sk_live_first-line\nsk_live_second-line\n'\n`
    )
    if (!isWindows) expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('--force over an existing file succeeds with the singular success line', async () => {
    writeFileSync(join(dir, '.env'), 'old')
    const result = await pvault('-s', 'DATABASE_URL', '-o', '.env', '--force')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe(`Wrote 1 secret to ${join(dir, '.env')}\n`)
  })

  const FAILURES: Array<[string, () => void, string[], number]> = [
    [
      'reserved target',
      () => {},
      ['-s', 'DATABASE_URL=LD_PRELOAD', '-o', '.env'],
      EXIT_CODES.usageError,
    ],
    ['zero --secret', () => {}, ['-o', '.env'], EXIT_CODES.secretsRequired],
    [
      'credential not found (after an already-fetched value)',
      () => {},
      ['-s', FETCHED_FIRST, '-s', 'MISSING', '-o', '.env'],
      EXIT_CODES.credentialNotFound,
    ],
    [
      'other-project / forbidden',
      () => {},
      ['-s', FETCHED_FIRST, '-s', 'FORBIDDEN', '-o', '.env'],
      EXIT_CODES.insufficientRole,
    ],
    [
      'rate limited (429)',
      () => {},
      ['-s', FETCHED_FIRST, '-s', 'THROTTLED', '-o', '.env'],
      EXIT_CODES.vaultRequestFailed,
    ],
    [
      'multi-field secret',
      () => {},
      ['-s', 'MULTI', '-o', '.env'],
      EXIT_CODES.multiFieldSecretUnsupported,
    ],
    [
      'unexpected fetch error',
      () => {},
      ['-s', FETCHED_FIRST, '-s', 'BOOM', '-o', '.env'],
      EXIT_CODES.unexpected,
    ],
    [
      'target exists',
      () => writeFileSync(join(dir, '.env'), 'x'),
      ['-s', FETCHED_FIRST, '-o', '.env'],
      EXIT_CODES.outputExists,
    ],
    [
      'parent missing',
      () => {},
      ['-s', FETCHED_FIRST, '-o', 'nope/.env'],
      EXIT_CODES.outputPathInvalid,
    ],
    [
      'target is a directory',
      () => mkdirSync(join(dir, 'd')),
      ['-s', FETCHED_FIRST, '-o', 'd', '--force'],
      EXIT_CODES.outputPathInvalid,
    ],
    [
      'unrepresentable value',
      () => {},
      ['-s', FETCHED_FIRST, '-s', 'UNREPRESENTABLE', '-o', '.env'],
      EXIT_CODES.valueNotRepresentable,
    ],
  ]

  it.each(FAILURES)(
    '%s → its exit code, nothing written, no value in output',
    async (_l, setup, args, code) => {
      setup()
      const before = snapshot(dir)
      const result = await pvault(...args)
      expect(result.exitCode).toBe(code)
      expect(result.stdout).toBe('')
      expect(result.stderr.length).toBeGreaterThan(0)
      // Nothing written: no new entry (not even a temp file), existing files byte-identical.
      expect(snapshot(dir)).toEqual(before)
    }
  )

  it.skipIf(isWindows || isRoot)(
    'unwritable directory → 28 with the code only, no value in output',
    async () => {
      chmodSync(dir, 0o500)
      const result = await pvault('-s', FETCHED_FIRST, '-o', '.env')
      expect(result.exitCode).toBe(EXIT_CODES.outputWriteFailed)
      expect(result.stderr).toBe(`Failed to write '${join(dir, '.env')}': EACCES\n`)
    }
  )
})
