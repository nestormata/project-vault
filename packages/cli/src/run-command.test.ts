import { EventEmitter } from 'node:events'
import { VaultAgentError } from '@project-vault/agent'
import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import type { ChildProcessLike, ParentProcessLike } from './inject-and-run.js'
import { runRun } from './run-command.js'

function makeStreams(isTTY = false) {
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

function makeFakeChild(): ChildProcessLike & {
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void
} {
  const emitter = new EventEmitter()
  return {
    on: (event, listener) => {
      emitter.on(event, listener)
    },
    kill: vi.fn().mockReturnValue(true),
    emitExit: (code, signal) => emitter.emit('exit', code, signal),
  }
}

function makeFakeParentProcess(): ParentProcessLike {
  return {
    pid: 1,
    platform: 'linux',
    on: () => {},
    removeListener: () => {},
    kill: vi.fn(),
  }
}

const validConfig = {
  apiKey: 'pk_abc123',
  baseUrl: 'https://vault.example.com',
  projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
}

const SECRET_VALUE = 'the-secret-value'

describe('runRun — Story 43.4 AC-4: the 43.3 opt-in gate is gone (generally available)', () => {
  it('runs immediately with no opt-in flag and prints no residual-risk warning', async () => {
    const streams = makeStreams()
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SECRET_VALUE)

    const resultPromise = runRun(
      { secrets: ['X'], command: 'cmd', commandArgs: [], secretsFd: false },
      validConfig,
      streams,
      {
        createVaultAgent: vi.fn().mockReturnValue({ getSecret }),
        spawn,
        parentProcess: makeFakeParentProcess(),
        env: {},
      }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)

    expect(await resultPromise).toBe(0)
    const stderr = streams.stderrChunks.join('')
    expect(stderr).not.toContain('allow-unhardened-injection')
    expect(stderr).not.toContain('/proc/<pid>/environ')
    expect(stderr).toBe('')
  })

  it('the run-command module no longer exports the retired opt-in gate', async () => {
    const mod: Record<string, unknown> = await import('./run-command.js')
    expect(mod['requireUnhardenedInjectionOptIn']).toBeUndefined()
  })
})

describe('runRun — Story 43.4 AC-2/AC-3: thin adapter over the seam', () => {
  it('--secrets-fd is passed through as fd delivery (value on FD 3, not in env)', async () => {
    const streams = makeStreams()
    const written: string[] = []
    const fakeChild = Object.assign(makeFakeChild(), {
      stdio: [null, null, null, { on: vi.fn(), end: (chunk: string) => void written.push(chunk) }],
    })
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SECRET_VALUE)

    const resultPromise = runRun(
      { secrets: ['DATABASE_URL'], command: 'psql', commandArgs: [], secretsFd: true },
      validConfig,
      streams,
      {
        createVaultAgent: vi.fn().mockReturnValue({ getSecret }),
        spawn,
        parentProcess: makeFakeParentProcess(),
        env: { EXISTING: 'x', VAULT_API_KEY: 'pk_abc123' },
      }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    expect(await resultPromise).toBe(0)

    expect(spawn).toHaveBeenCalledWith('psql', [], {
      env: { EXISTING: 'x', PVAULT_SECRETS_FD: '3' },
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    })
    expect(JSON.parse(written[0] ?? '')).toEqual({ DATABASE_URL: SECRET_VALUE })
    expect(streams.stderrChunks.join('')).not.toContain(SECRET_VALUE)
  })

  it('forwards the seam-computed invocation context to the agent', async () => {
    const streams = makeStreams()
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SECRET_VALUE)

    const resultPromise = runRun(
      { secrets: ['A'], command: './bin/migrate', commandArgs: ['--up'], secretsFd: false },
      validConfig,
      streams,
      {
        createVaultAgent: vi.fn().mockReturnValue({ getSecret }),
        spawn,
        parentProcess: makeFakeParentProcess(),
        env: {},
      }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    expect(getSecret).toHaveBeenCalledWith('A', { invocation: 'run', targetCommand: 'migrate' })
  })
})

describe('runRun — AC-1 usage errors', () => {
  it('zero --secret flags is a usage error (secretsRequired)', async () => {
    const streams = makeStreams()
    const exitCode = await runRun(
      { secrets: [], command: 'cmd', commandArgs: [], secretsFd: false },
      validConfig,
      streams,
      { createVaultAgent: vi.fn(), spawn: vi.fn(), parentProcess: makeFakeParentProcess(), env: {} }
    )
    expect(exitCode).toBe(EXIT_CODES.secretsRequired)
  })

  it('--secrets-fd with zero --secret flags is still the secretsRequired usage error (Story 43.4 AC-2)', async () => {
    const streams = makeStreams()
    const exitCode = await runRun(
      { secrets: [], command: 'cmd', commandArgs: [], secretsFd: true },
      validConfig,
      streams,
      { createVaultAgent: vi.fn(), spawn: vi.fn(), parentProcess: makeFakeParentProcess(), env: {} }
    )
    expect(exitCode).toBe(EXIT_CODES.secretsRequired)
  })

  it('a malformed --secret value is a usage error, before any fetch', async () => {
    const streams = makeStreams()
    const createVaultAgent = vi.fn()
    const exitCode = await runRun(
      { secrets: ['=EMPTY_NAME'], command: 'cmd', commandArgs: [], secretsFd: false },
      validConfig,
      streams,
      { createVaultAgent, spawn: vi.fn(), parentProcess: makeFakeParentProcess(), env: {} }
    )
    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(createVaultAgent).not.toHaveBeenCalled()
  })
})

describe('runRun — success path', () => {
  it('fetches the requested secret and spawns the command with it injected, propagating the real exit code', async () => {
    const streams = makeStreams()
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SECRET_VALUE)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const resultPromise = runRun(
      {
        secrets: ['DATABASE_URL'],
        command: 'psql',
        commandArgs: [],
        secretsFd: false,
      },
      validConfig,
      streams,
      { createVaultAgent, spawn, parentProcess: makeFakeParentProcess(), env: { EXISTING: 'x' } }
    )

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    const exitCode = await resultPromise

    expect(exitCode).toBe(0)
    expect(createVaultAgent).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pk_abc123', baseUrl: 'https://vault.example.com' })
    )
    expect(spawn).toHaveBeenCalledWith('psql', [], {
      env: { EXISTING: 'x', DATABASE_URL: SECRET_VALUE },
      stdio: 'inherit',
    })
    // Security-relevant: the fetched value never reaches the parent CLI's own stdout/stderr.
    expect(streams.stdoutChunks.join('')).toBe('')
    expect(streams.stderrChunks.join('')).not.toContain(SECRET_VALUE)
  })

  it('never spawns the child when a requested secret fails to fetch (fail-closed)', async () => {
    const streams = makeStreams()
    const spawn = vi.fn()
    const getSecret = vi.fn().mockRejectedValue(new VaultAgentError('credential_not_found', 'nope'))
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runRun(
      { secrets: ['MISSING'], command: 'cmd', commandArgs: [], secretsFd: false },
      validConfig,
      streams,
      { createVaultAgent, spawn, parentProcess: makeFakeParentProcess(), env: {} }
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(exitCode).toBe(EXIT_CODES.credentialNotFound)
    expect(streams.stderrChunks.join('')).toContain('MISSING')
  })
})
