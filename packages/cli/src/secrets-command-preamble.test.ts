import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { prepareSecretsCommand } from './secrets-command-preamble.js'

const validConfig = {
  apiKey: 'pk_abc',
  baseUrl: 'https://vault.example.com',
  projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
}
const USAGE = { commandName: 'write-env', usage: 'pvault write-env --secret NAME --output PATH' }

function makeStderr() {
  const chunks: string[] = []
  return { stderr: { write: (c: string) => void chunks.push(c) }, chunks }
}

describe('prepareSecretsCommand (Story 43.5 decision #9 — shared by run and write-env)', () => {
  it('zero --secret flags → secretsRequired with the command-specific usage, no agent', () => {
    const { stderr, chunks } = makeStderr()
    const createVaultAgent = vi.fn()
    const result = prepareSecretsCommand([], USAGE, validConfig, stderr, createVaultAgent)
    expect(result).toEqual({ ok: false, exitCode: EXIT_CODES.secretsRequired })
    expect(chunks.join('')).toBe(
      'pvault write-env requires at least one --secret flag. Usage: pvault write-env --secret NAME --output PATH\n'
    )
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it('a malformed --secret → usage error with the parser message, no agent', () => {
    const { stderr, chunks } = makeStderr()
    const createVaultAgent = vi.fn()
    const result = prepareSecretsCommand(['=X'], USAGE, validConfig, stderr, createVaultAgent)
    expect(result).toEqual({ ok: false, exitCode: EXIT_CODES.usageError })
    expect(chunks.join('')).toContain('malformed')
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it('a non-UUID project id → usage error, no agent', () => {
    const { stderr, chunks } = makeStderr()
    const createVaultAgent = vi.fn()
    const result = prepareSecretsCommand(
      ['A'],
      USAGE,
      { ...validConfig, projectId: 'my-project' },
      stderr,
      createVaultAgent
    )
    expect(result).toEqual({ ok: false, exitCode: EXIT_CODES.usageError })
    expect(chunks.join('')).toContain("'my-project' must be the project's UUID")
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it('valid input → parsed entries and a created agent', () => {
    const { stderr } = makeStderr()
    const agent = { getSecret: vi.fn() }
    const createVaultAgent = vi.fn().mockReturnValue(agent)
    const result = prepareSecretsCommand(['A', 'b=B'], USAGE, validConfig, stderr, createVaultAgent)
    expect(result).toEqual({
      ok: true,
      entries: [
        { credentialName: 'A', envVarName: 'A' },
        { credentialName: 'b', envVarName: 'B' },
      ],
      agent,
    })
    expect(createVaultAgent).toHaveBeenCalledWith(validConfig)
  })
})
