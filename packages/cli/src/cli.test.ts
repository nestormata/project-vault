import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.js'
import { EXIT_CODES } from './exit-codes.js'

/** Reused as both the fixture project id and (in the login-response fixture) userId — the tests
 * below don't assert any relationship between the two, so one arbitrary UUID literal suffices. */
const FIXTURE_UUID = 'a1c2d3e4-0000-0000-0000-000000000000'

const VALID_ENV = {
  VAULT_API_KEY: 'pk_abc',
  VAULT_URL: 'https://vault.example.com',
  VAULT_PROJECT_ID: FIXTURE_UUID,
}

const DATABASE_URL = 'DATABASE_URL'
const ALLOW_UNHARDENED_INJECTION_FLAG = '--allow-unhardened-injection'

function makeStreams(isTTY: boolean) {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => void stdoutChunks.push(chunk) },
    stderr: { write: (chunk: string) => void stderrChunks.push(chunk) },
    isTTY,
    stdoutChunks,
    stderrChunks,
  }
}

/** Story 43.2 — every `buildProgram()` call needs a `prompt`/`fetchFn`, even tests that only
 * exercise the `get` command wiring above (unchanged by this story). Neither is invoked unless a
 * test actually drives `login`/`logout`. */
function unusedPrompt(): never {
  throw new Error('prompt() should not be called by this test')
}
function unusedFetch(): never {
  throw new Error('fetchFn() should not be called by this test')
}
/** Story 43.3 — every `buildProgram()` call needs `spawn`/`parentProcess` too, even tests that
 * only exercise `get`/`login`/`logout` wiring (unchanged by this story). */
function unusedSpawn(): never {
  throw new Error('spawn() should not be called by this test')
}
const unusedParentProcess = {
  pid: -1,
  platform: 'linux' as NodeJS.Platform,
  on: () => {
    throw new Error('parentProcess.on() should not be called by this test')
  },
  removeListener: () => {
    throw new Error('parentProcess.removeListener() should not be called by this test')
  },
  kill: () => {
    throw new Error('parentProcess.kill() should not be called by this test')
  },
}

describe('buildProgram — `get <name>` command wiring', () => {
  it('resolves config from env, calls runGet, and reports its exit code via setExitCode', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('the-value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'get', DATABASE_URL])

    expect(streams.stdoutChunks.join('')).toBe('the-value')
    expect(setExitCode).toHaveBeenCalledWith(0)
    expect(getSecret).toHaveBeenCalledWith(DATABASE_URL)
  })

  it('--api-key/--url/--project-id flags override env vars', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('v')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: {},
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync([
      'node',
      'pvault',
      'get',
      'FOO',
      '--api-key',
      'pk_flag',
      '--url',
      'https://flag.example.com',
      '--project-id',
      FIXTURE_UUID,
    ])

    expect(createVaultAgent).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pk_flag', baseUrl: 'https://flag.example.com' })
    )
    expect(setExitCode).toHaveBeenCalledWith(0)
  })

  it('reports the usage-error exit code and never calls createVaultAgent when config is missing', async () => {
    const streams = makeStreams(false)
    const createVaultAgent = vi.fn()
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: {},
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'get', 'FOO'])

    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(streams.stderrChunks.join('')).toMatch(/VAULT_API_KEY/)
  })

  it('--stdout flag is threaded through to runGet, overriding a TTY refusal', async () => {
    const streams = makeStreams(true)
    const getSecret = vi.fn().mockResolvedValue('v')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'get', 'FOO', '--stdout'])

    expect(setExitCode).toHaveBeenCalledWith(0)
    expect(streams.stdoutChunks.join('')).toBe('v')
  })

  it('refuses on a TTY without --stdout, through the real commander wiring', async () => {
    const streams = makeStreams(true)
    const createVaultAgent = vi.fn()
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'get', 'FOO'])

    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(1)
  })
})

describe('buildProgram — `login`/`logout` command wiring (Story 43.2)', () => {
  let xdgHome: string

  beforeEach(() => {
    xdgHome = mkdtempSync(join(tmpdir(), 'pvault-cli-test-'))
  })

  afterEach(() => {
    rmSync(xdgHome, { recursive: true, force: true })
  })

  it('security hardening: the `login` command definition has no --password option', () => {
    const streams = makeStreams(false)
    const program = buildProgram({
      streams,
      env: { XDG_CONFIG_HOME: xdgHome },
      createVaultAgent: vi.fn(),
      setExitCode: vi.fn(),
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })

    const loginCommand = program.commands.find((c) => c.name() === 'login')
    expect(loginCommand).toBeDefined()
    const optionFlags = (loginCommand?.options ?? []).map((o) => o.long)
    expect(optionFlags).not.toContain('--password')
    expect(optionFlags).not.toContain('--email')
  })

  it('resolves VAULT_URL from env, prompts, and reports the login exit code via setExitCode', async () => {
    const streams = makeStreams(false)
    const setExitCode = vi.fn()
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          data: {
            accessToken: 'a',
            refreshToken: 'r',
            tokenType: 'Bearer',
            expiresIn: 300,
            userId: FIXTURE_UUID,
            orgId: 'b1c2d3e4-0000-0000-0000-000000000000',
          },
        }),
    } as Response)
    const answers = ['dev@example.com', 'hunter2']
    let i = 0
    const prompt = vi.fn(async () => {
      const v = answers[i]
      i += 1
      return v as string
    })

    const program = buildProgram({
      streams,
      env: { VAULT_URL: 'https://vault.example.com', XDG_CONFIG_HOME: xdgHome },
      createVaultAgent: vi.fn(),
      setExitCode,
      prompt,
      fetchFn,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'login'])

    expect(fetchFn).toHaveBeenCalledWith(
      'https://vault.example.com/api/v1/auth/cli-login',
      expect.anything()
    )
    expect(setExitCode).toHaveBeenCalledWith(0)
  })

  it('login reports a usage error and never prompts when VAULT_URL is missing', async () => {
    const streams = makeStreams(false)
    const setExitCode = vi.fn()
    const prompt = vi.fn()

    const program = buildProgram({
      streams,
      env: { XDG_CONFIG_HOME: xdgHome },
      createVaultAgent: vi.fn(),
      setExitCode,
      prompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'login'])

    expect(prompt).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.usageError)
    expect(streams.stderrChunks.join('')).toMatch(/VAULT_URL/)
  })

  it('logout deletes the session and reports exit code 0 via setExitCode', async () => {
    const streams = makeStreams(false)
    const setExitCode = vi.fn()
    const fetchFn = vi.fn()

    const program = buildProgram({
      streams,
      env: { XDG_CONFIG_HOME: xdgHome },
      createVaultAgent: vi.fn(),
      setExitCode,
      prompt: unusedPrompt,
      fetchFn,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })
    await program.parseAsync(['node', 'pvault', 'logout'])

    expect(setExitCode).toHaveBeenCalledWith(0)
    expect(streams.stdoutChunks.join('')).toContain('logged in')
  })
})

describe('buildProgram — `run` command wiring (Story 43.3)', () => {
  function makeFakeChild() {
    const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    return {
      on: (
        event: 'exit',
        listener: (code: number | null, signal: NodeJS.Signals | null) => void
      ) => {
        listeners.push(listener)
      },
      kill: vi.fn(),
      emitExit: (code: number | null, signal: NodeJS.Signals | null) => {
        for (const l of listeners) l(code, signal)
      },
    }
  }

  const runParentProcess = {
    pid: 1,
    platform: 'linux' as NodeJS.Platform,
    on: () => {},
    removeListener: () => {},
    kill: () => {},
  }

  /** Every `run` test's argv shares the `['node', 'pvault', 'run', ...]` prefix — a small helper
   * avoids duplicating those three literals across every test's parseAsync() call. */
  function runArgv(...rest: string[]): string[] {
    return ['node', 'pvault', 'run', ...rest]
  }

  const SECRET_VALUE = 'the-secret-value'

  it('security hardening: the `run` command definition has no flag whose value is treated as a secret value', () => {
    const streams = makeStreams(false)
    const program = buildProgram({
      streams,
      env: {},
      createVaultAgent: vi.fn(),
      setExitCode: vi.fn(),
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })

    const runCommand = program.commands.find((c) => c.name() === 'run')
    expect(runCommand).toBeDefined()
    const optionFlags = (runCommand?.options ?? []).map((o) => o.long)
    // `--secret` takes a credential NAME (never accepts a literal secret value as argv) — no
    // `--secret-value`/`--value` flag exists.
    expect(optionFlags).toContain('--secret')
    expect(optionFlags).not.toContain('--secret-value')
    expect(optionFlags).not.toContain('--value')
  })

  it('resolves config, fetches the requested secret, spawns the command, and reports its real exit code', async () => {
    const streams = makeStreams(false)
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SECRET_VALUE)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn,
      parentProcess: runParentProcess,
    })

    const parsePromise = program.parseAsync(
      runArgv(
        '--secret',
        DATABASE_URL,
        ALLOW_UNHARDENED_INJECTION_FLAG,
        '--',
        'psql',
        '-c',
        'select 1'
      )
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await parsePromise

    expect(getSecret).toHaveBeenCalledWith(DATABASE_URL)
    expect(spawn).toHaveBeenCalledWith(
      'psql',
      ['-c', 'select 1'],
      expect.objectContaining({ env: expect.objectContaining({ DATABASE_URL: SECRET_VALUE }) })
    )
    expect(setExitCode).toHaveBeenCalledWith(0)
    expect(streams.stdoutChunks.join('')).toBe('')
    expect(streams.stderrChunks.join('')).not.toContain(SECRET_VALUE)
  })

  it('refuses without --allow-unhardened-injection, never calling createVaultAgent/spawn', async () => {
    const streams = makeStreams(false)
    const spawn = vi.fn()
    const createVaultAgent = vi.fn()
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn,
      parentProcess: runParentProcess,
    })

    await program.parseAsync(runArgv('--secret', DATABASE_URL, '--', 'psql'))

    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.unhardenedInjectionNotAcknowledged)
    expect(streams.stderrChunks.join('')).toContain(ALLOW_UNHARDENED_INJECTION_FLAG)
  })

  it('rejects a missing "--" separator with a clear usage error, before commander misparses the trailing command as its own flags', async () => {
    const streams = makeStreams(false)
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent: vi.fn(),
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: runParentProcess,
    })

    await expect(
      program.parseAsync(runArgv('--secret', 'X', ALLOW_UNHARDENED_INJECTION_FLAG, 'ls', '-la'))
    ).rejects.toThrow()

    expect(streams.stderrChunks.join('')).toContain('missing "--" separator')
  })

  it('rejects an empty command after "--" with a clear usage error', async () => {
    const streams = makeStreams(false)
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent: vi.fn(),
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: runParentProcess,
    })

    await expect(
      program.parseAsync(runArgv('--secret', 'X', ALLOW_UNHARDENED_INJECTION_FLAG, '--'))
    ).rejects.toThrow()

    expect(streams.stderrChunks.join('')).toContain('no command given')
  })

  it("passes everything after '--' through to the child untouched, including flags that look like pvault's own options", async () => {
    const streams = makeStreams(false)
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn,
      parentProcess: runParentProcess,
    })

    const parsePromise = program.parseAsync(
      runArgv('--secret', 'X', ALLOW_UNHARDENED_INJECTION_FLAG, '--', 'ls', '--help', '-la')
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await parsePromise

    expect(spawn).toHaveBeenCalledWith('ls', ['--help', '-la'], expect.anything())
  })

  it('multiple --secret flags are all injected', async () => {
    const streams = makeStreams(false)
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockImplementation((name: string) => Promise.resolve(`v-${name}`))
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn,
      parentProcess: runParentProcess,
    })

    const parsePromise = program.parseAsync(
      runArgv('--secret', 'A', '--secret', 'B', ALLOW_UNHARDENED_INJECTION_FLAG, '--', 'cmd')
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await parsePromise

    expect(spawn).toHaveBeenCalledWith(
      'cmd',
      [],
      expect.objectContaining({ env: expect.objectContaining({ A: 'v-A', B: 'v-B' }) })
    )
  })

  it('zero --secret flags reports the secretsRequired exit code', async () => {
    const streams = makeStreams(false)
    const setExitCode = vi.fn()
    const createVaultAgent = vi.fn()

    const program = buildProgram({
      streams,
      env: VALID_ENV,
      createVaultAgent,
      setExitCode,
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: runParentProcess,
    })

    await program.parseAsync(runArgv(ALLOW_UNHARDENED_INJECTION_FLAG, '--', 'ls'))

    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(EXIT_CODES.secretsRequired)
  })
})
