import { EventEmitter } from 'node:events'
import { VaultAgentError } from '@project-vault/agent'
import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import type { ChildProcessLike, ParentProcessLike } from './inject-and-run.js'
import { requireUnhardenedInjectionOptIn, runRun } from './run-command.js'

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

describe('requireUnhardenedInjectionOptIn (Dev Notes decision #6, AC-5)', () => {
  it('refuses and prints the named risk when the flag is absent, without proceeding', () => {
    const stderrChunks: string[] = []
    const proceed = requireUnhardenedInjectionOptIn(false, (c) => stderrChunks.push(c))

    expect(proceed).toBe(false)
    expect(stderrChunks.join('')).toContain('--allow-unhardened-injection')
    expect(stderrChunks.join('')).toContain('/proc/<pid>/environ')
  })

  it('proceeds and still prints the warning every time when the flag is present', () => {
    const stderrChunks: string[] = []
    const proceed = requireUnhardenedInjectionOptIn(true, (c) => stderrChunks.push(c))

    expect(proceed).toBe(true)
    expect(stderrChunks.join('')).toContain('injects secrets into a process')
  })
})

describe('runRun — AC-5 gate', () => {
  it('refuses with unhardenedInjectionNotAcknowledged before ever calling getSecret/spawn', async () => {
    const streams = makeStreams()
    const createVaultAgent = vi.fn()
    const spawn = vi.fn()

    const exitCode = await runRun(
      { secrets: ['X'], command: 'cmd', commandArgs: [], allowUnhardenedInjection: false },
      validConfig,
      streams,
      { createVaultAgent, spawn, parentProcess: makeFakeParentProcess(), env: {} }
    )

    expect(exitCode).toBe(EXIT_CODES.unhardenedInjectionNotAcknowledged)
    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('an env var alone (no CLI flag) does not bypass the gate', async () => {
    // requireUnhardenedInjectionOptIn only ever receives the CLI-argument-derived boolean — this
    // test documents that runRun has no env-var-reading code path for this flag at all.
    const streams = makeStreams()
    const exitCode = await runRun(
      { secrets: ['X'], command: 'cmd', commandArgs: [], allowUnhardenedInjection: false },
      validConfig,
      streams,
      {
        createVaultAgent: vi.fn(),
        spawn: vi.fn(),
        parentProcess: makeFakeParentProcess(),
        env: { VAULT_ALLOW_UNHARDENED: '1' },
      }
    )
    expect(exitCode).toBe(EXIT_CODES.unhardenedInjectionNotAcknowledged)
  })
})

describe('runRun — AC-1 usage errors', () => {
  it('zero --secret flags is a usage error (secretsRequired)', async () => {
    const streams = makeStreams()
    const exitCode = await runRun(
      { secrets: [], command: 'cmd', commandArgs: [], allowUnhardenedInjection: true },
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
      { secrets: ['=EMPTY_NAME'], command: 'cmd', commandArgs: [], allowUnhardenedInjection: true },
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
        allowUnhardenedInjection: true,
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
      { secrets: ['MISSING'], command: 'cmd', commandArgs: [], allowUnhardenedInjection: true },
      validConfig,
      streams,
      { createVaultAgent, spawn, parentProcess: makeFakeParentProcess(), env: {} }
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(exitCode).toBe(EXIT_CODES.credentialNotFound)
    expect(streams.stderrChunks.join('')).toContain('MISSING')
  })
})
