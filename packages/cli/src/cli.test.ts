import { describe, expect, it, vi } from 'vitest'
import { buildProgram } from './cli.js'

const VALID_ENV = {
  VAULT_API_KEY: 'pk_abc',
  VAULT_URL: 'https://vault.example.com',
  VAULT_PROJECT_ID: 'a1c2d3e4-0000-0000-0000-000000000000',
}

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

describe('buildProgram — `get <name>` command wiring', () => {
  it('resolves config from env, calls runGet, and reports its exit code via setExitCode', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('the-value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({ streams, env: VALID_ENV, createVaultAgent, setExitCode })
    await program.parseAsync(['node', 'pvault', 'get', 'DATABASE_URL'])

    expect(streams.stdoutChunks.join('')).toBe('the-value')
    expect(setExitCode).toHaveBeenCalledWith(0)
    expect(getSecret).toHaveBeenCalledWith('DATABASE_URL')
  })

  it('--api-key/--url/--project-id flags override env vars', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('v')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const setExitCode = vi.fn()

    const program = buildProgram({ streams, env: {}, createVaultAgent, setExitCode })
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
      'a1c2d3e4-0000-0000-0000-000000000000',
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

    const program = buildProgram({ streams, env: {}, createVaultAgent, setExitCode })
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

    const program = buildProgram({ streams, env: VALID_ENV, createVaultAgent, setExitCode })
    await program.parseAsync(['node', 'pvault', 'get', 'FOO', '--stdout'])

    expect(setExitCode).toHaveBeenCalledWith(0)
    expect(streams.stdoutChunks.join('')).toBe('v')
  })

  it('refuses on a TTY without --stdout, through the real commander wiring', async () => {
    const streams = makeStreams(true)
    const createVaultAgent = vi.fn()
    const setExitCode = vi.fn()

    const program = buildProgram({ streams, env: VALID_ENV, createVaultAgent, setExitCode })
    await program.parseAsync(['node', 'pvault', 'get', 'FOO'])

    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(setExitCode).toHaveBeenCalledWith(1)
  })
})
