import { describe, expect, it, vi } from 'vitest'

// Story 43.2 — `get`/`login`'s command actions in cli.ts each have a defensive
// `catch (error) { if (error instanceof CliUsageError) {...}; throw error }` rethrow for any
// error their delegate (`runGet`/`runLogin`) does *not* itself turn into a handled exit code.
// Neither delegate throws a non-CliUsageError today (both are internally exhaustive), so this
// exercises that defensive path directly by mocking the delegate to reject with an arbitrary
// error, asserting cli.ts propagates it instead of silently swallowing it.
vi.mock('./get-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./get-command.js')>()
  return { ...actual, runGet: vi.fn().mockRejectedValue(new Error('boom-get')) }
})
vi.mock('./login-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./login-command.js')>()
  return { ...actual, runLogin: vi.fn().mockRejectedValue(new Error('boom-login')) }
})

const { buildProgram } = await import('./cli.js')

function makeStreams() {
  return {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    isTTY: false,
  }
}

function unusedPrompt(): never {
  throw new Error('prompt() should not be called by this test')
}
function unusedFetch(): never {
  throw new Error('fetchFn() should not be called by this test')
}
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

describe('buildProgram — non-CliUsageError errors propagate uncaught', () => {
  it('get: rethrows instead of swallowing an unexpected error from runGet', async () => {
    const program = buildProgram({
      streams: makeStreams(),
      env: {
        VAULT_API_KEY: 'pk_abc',
        VAULT_URL: 'https://vault.example.com',
        VAULT_PROJECT_ID: 'a1c2d3e4-0000-0000-0000-000000000000',
      },
      createVaultAgent: vi.fn().mockReturnValue({ getSecret: vi.fn() }),
      setExitCode: vi.fn(),
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })

    await expect(program.parseAsync(['node', 'pvault', 'get', 'FOO'])).rejects.toThrow('boom-get')
  })

  it('login: rethrows instead of swallowing an unexpected error from runLogin', async () => {
    const program = buildProgram({
      streams: makeStreams(),
      env: { VAULT_URL: 'https://vault.example.com' },
      createVaultAgent: vi.fn(),
      setExitCode: vi.fn(),
      prompt: unusedPrompt,
      fetchFn: unusedFetch,
      spawn: unusedSpawn,
      parentProcess: unusedParentProcess,
    })

    await expect(program.parseAsync(['node', 'pvault', 'login'])).rejects.toThrow('boom-login')
  })
})
