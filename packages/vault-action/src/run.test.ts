/* eslint-disable sonarjs/no-duplicate-string -- '@project-vault/agent' is a module specifier that
   legitimately repeats across vi.mock(), a type-only import, and several dynamic re-imports of
   this mocked module in the same test file; a variable would not improve readability here. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT_A = 'a1c2d3e4-0000-0000-0000-000000000000'
const PROJECT_B = 'b5f6a7c8-0000-0000-0000-000000000000'
const VAULT_URL = 'https://vault.example.com'
const AGENT_MODULE = '@project-vault/agent'
const SECRET_VALUE = 'super-secret-value'

type Inputs = {
  'vault-url'?: string
  'api-key'?: string
  secrets?: string
  'continue-on-error'?: string
}

const state: {
  inputs: Inputs
  getSecretImpl: (name: string) => Promise<string>
} = {
  inputs: {},
  getSecretImpl: async () => {
    throw new Error('not configured')
  },
}

const calls: { fn: string; args: unknown[] }[] = []

function record(fn: string, ...args: unknown[]): void {
  calls.push({ fn, args })
}

vi.mock('@actions/core', () => {
  return {
    getInput: vi.fn((name: string, options?: { required?: boolean }) => {
      const value = state.inputs[name as keyof Inputs]
      record('getInput', name)
      if ((value === undefined || value === '') && options?.required) {
        throw new Error(`Input required and not supplied: ${name}`)
      }
      return value ?? ''
    }),
    getBooleanInput: vi.fn((name: string) => {
      const raw = state.inputs[name as keyof Inputs] ?? 'false'
      record('getBooleanInput', name)
      const normalized = raw.trim().toLowerCase()
      if (normalized === 'true') return true
      if (normalized === 'false') return false
      throw new Error(
        `TypeError: Input does not meet YAML 1.2 "Core Schema" specification: ${name}`
      )
    }),
    setSecret: vi.fn((value: string) => record('setSecret', value)),
    exportVariable: vi.fn((name: string, value: string) => record('exportVariable', name, value)),
    setFailed: vi.fn((message: string) => record('setFailed', message)),
    warning: vi.fn((message: string) => record('warning', message)),
    info: vi.fn((message: string) => record('info', message)),
    debug: vi.fn((message: string) => record('debug', message)),
  }
})

vi.mock('@project-vault/agent', async () => {
  const actual = await vi.importActual<typeof import('@project-vault/agent')>(AGENT_MODULE)
  return {
    ...actual,
    createVaultAgent: vi.fn(() => ({
      getSecret: (name: string) => state.getSecretImpl(name),
    })),
  }
})

const core = await import('@actions/core')
const { createVaultAgent, VaultAgentError } = await import(AGENT_MODULE)
const { run } = await import('./run.js')

function setInputs(inputs: Inputs): void {
  state.inputs = { 'vault-url': VAULT_URL, 'api-key': 'pk_test123', ...inputs }
}

beforeEach(() => {
  calls.length = 0
  state.inputs = {}
  state.getSecretImpl = async () => {
    throw new Error('not configured')
  }
  vi.clearAllMocks()
})

function callOrder(fnName: string): number {
  return calls.findIndex((c) => c.fn === fnName)
}

describe('run() — scenario 1: successful single-secret retrieval', () => {
  it('masks the value before exporting it, and never fails/warns', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    state.getSecretImpl = async (name) => {
      expect(name).toBe('DATABASE_URL')
      return SECRET_VALUE
    }

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.setSecret).toHaveBeenCalledWith(SECRET_VALUE)
    expect(core.exportVariable).toHaveBeenCalledWith('DB_URL', SECRET_VALUE)
    const setSecretIdx = calls.findIndex((c) => c.fn === 'setSecret' && c.args[0] === SECRET_VALUE)
    const exportIdx = callOrder('exportVariable')
    expect(setSecretIdx).toBeLessThan(exportIdx)
  })
})

describe('run() — D2/AC-8: agent construction', () => {
  it('constructs exactly one agent per invocation with fallbackThreshold: 1 (short-circuit sustained outages)', async () => {
    setInputs({
      secrets: [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_A}/REDIS_URL as REDIS_URL`].join(
        '\n'
      ),
    })
    state.getSecretImpl = async () => 'value'

    await run()

    expect(createVaultAgent).toHaveBeenCalledTimes(1)
    expect(createVaultAgent).toHaveBeenCalledWith({
      apiKey: 'pk_test123',
      baseUrl: VAULT_URL,
      projectId: PROJECT_A,
      fallbackThreshold: 1,
    })
  })
})

describe('run() — scenario 2: successful multi-secret retrieval (AC-3)', () => {
  it('exports all three entries in input order', async () => {
    setInputs({
      secrets: [
        `${PROJECT_A}/DATABASE_URL as DB_URL`,
        `${PROJECT_A}/STRIPE_SECRET_KEY as STRIPE_KEY`,
        `${PROJECT_A}/REDIS_URL as REDIS_URL`,
      ].join('\n'),
    })
    state.getSecretImpl = async (name) => `value-for-${name}`

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const exportCalls = calls.filter((c) => c.fn === 'exportVariable')
    expect(exportCalls.map((c) => c.args[0])).toEqual(['DB_URL', 'STRIPE_KEY', 'REDIS_URL'])
  })
})

describe('run() — scenario 3: vault unreachable, continue-on-error false (default, AC-7)', () => {
  it('calls setFailed and never calls warning', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    const { VaultUnreachableError } = await import('@project-vault/agent')
    state.getSecretImpl = async () => {
      throw new VaultUnreachableError('DATABASE_URL')
    }

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(core.setFailed).toHaveBeenCalledWith(
      `Failed to retrieve secret 'DATABASE_URL': vault at ${VAULT_URL} is unreachable`
    )
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.exportVariable).not.toHaveBeenCalled()
  })
})

describe('run() — scenario 4: vault unreachable, continue-on-error true (AC-8)', () => {
  it('calls warning, never setFailed, and still attempts remaining entries', async () => {
    setInputs({
      'continue-on-error': 'true',
      secrets: [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_A}/REDIS_URL as REDIS_URL`].join(
        '\n'
      ),
    })
    const { VaultUnreachableError } = await import('@project-vault/agent')
    let attempts = 0
    state.getSecretImpl = async (name) => {
      attempts += 1
      throw new VaultUnreachableError(name)
    }

    await run()

    expect(attempts).toBe(2)
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('continuing because continue-on-error is true')
    )
  })
})

describe('run() — scenario 5: mixed vault-unreachable + application-error under continue-on-error true', () => {
  it('still fails the step for the application-level error even though vault-unreachable only warned', async () => {
    setInputs({
      'continue-on-error': 'true',
      secrets: [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_A}/API_KEY as API_KEY`].join(
        '\n'
      ),
    })
    const { VaultUnreachableError } = await import('@project-vault/agent')
    state.getSecretImpl = async (name) => {
      if (name === 'DATABASE_URL') throw new VaultUnreachableError(name)
      throw new VaultAgentError('credential_not_found', `Credential "${name}" was not found`)
    }

    await run()

    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('credential not found in project')
    )
  })
})

describe('run() — scenario 6: cross-project mismatch (AC-4)', () => {
  it('calls setFailed and never constructs the agent or calls getSecret', async () => {
    setInputs({
      secrets: [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_B}/API_TOKEN as API_TOKEN`].join(
        '\n'
      ),
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('must reference the same project')
    )
    expect(createVaultAgent).not.toHaveBeenCalled()
  })
})

describe('run() — scenario 7: duplicate ENV_VAR_NAME targets (AC-3 edge case)', () => {
  it('fails before any retrieval attempt', async () => {
    setInputs({
      secrets: [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_A}/OTHER as DB_URL`].join('\n'),
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('Duplicate environment variable target: DB_URL')
    expect(createVaultAgent).not.toHaveBeenCalled()
  })
})

describe('run() — scenario 8: api-key masked before any other core.* call (AC-10)', () => {
  it('calls setSecret(apiKey) before the getInput call that reads any other input', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    state.getSecretImpl = async () => 'value'

    await run()

    const maskApiKeyIdx = calls.findIndex((c) => c.fn === 'setSecret' && c.args[0] === 'pk_test123')
    const otherInputIdx = calls.findIndex((c) => c.fn === 'getInput' && c.args[0] !== 'api-key')
    expect(maskApiKeyIdx).toBeGreaterThanOrEqual(0)
    expect(maskApiKeyIdx).toBeLessThan(otherInputIdx)
  })

  it('never calls info/debug/warning before the api-key is masked', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    state.getSecretImpl = async () => 'value'

    await run()

    const maskApiKeyIdx = calls.findIndex((c) => c.fn === 'setSecret' && c.args[0] === 'pk_test123')
    const firstLogIdx = calls.findIndex(
      (c) => c.fn === 'info' || c.fn === 'debug' || c.fn === 'warning'
    )
    if (firstLogIdx !== -1) expect(maskApiKeyIdx).toBeLessThan(firstLogIdx)
  })
})

describe('run() — scenario 9: malformed secrets line', () => {
  it('fails with a parsing-specific message, distinct from a retrieval message', async () => {
    setInputs({ secrets: 'not-a-valid-line' })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/Malformed 'secrets' line/))
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it('fails on empty secrets input', async () => {
    setInputs({ secrets: '   ' })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      "The 'secrets' input must contain at least one PROJECT/NAME as ENV_VAR mapping"
    )
  })
})

describe('run() — scenario 10: partial-failure summary (AC-9 edge case)', () => {
  it('attempts all entries, exports the successes, and names the failing entry in the summary', async () => {
    setInputs({
      secrets: [
        `${PROJECT_A}/DATABASE_URL as DB_URL`,
        `${PROJECT_A}/STRIPE_KEY as STRIPE_KEY`,
        `${PROJECT_A}/REDIS_URL as REDIS_URL`,
      ].join('\n'),
    })
    state.getSecretImpl = async (name) => {
      if (name === 'DATABASE_URL') {
        throw new VaultAgentError('credential_not_found', 'Credential "DATABASE_URL" was not found')
      }
      return `value-for-${name}`
    }

    await run()

    const exportCalls = calls.filter((c) => c.fn === 'exportVariable')
    expect(exportCalls.map((c) => c.args[0])).toEqual(['STRIPE_KEY', 'REDIS_URL'])
    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'))
  })
})

describe('run() — scenario 11: dangerous/reserved ENV_VAR_NAME target', () => {
  it('rejects a mapping targeting PATH before any network call', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as PATH` })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('reserved/dangerous'))
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it('does not reject an ordinary identifier', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as MY_APP_SECRET` })
    state.getSecretImpl = async () => 'value'

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
  })
})

describe('run() — scenario 12: case-insensitive duplicate/cross-project detection', () => {
  it('treats DB_URL and db_url as a duplicate', async () => {
    setInputs({
      secrets: [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_A}/OTHER as db_url`].join('\n'),
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate environment variable target')
    )
  })

  it('treats hex-digit-casing-differing project ids as the same project', async () => {
    setInputs({
      secrets: [
        `${PROJECT_A}/DATABASE_URL as DB_URL`,
        `${PROJECT_A.toUpperCase()}/OTHER as OTHER_VAR`,
      ].join('\n'),
    })
    state.getSecretImpl = async () => 'value'

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(createVaultAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_A.toLowerCase() })
    )
  })
})

describe('run() — scenario 13: multi-line secret masking (AC-6 edge case)', () => {
  it('masks the full value and each non-empty line before exporting', async () => {
    setInputs({ secrets: `${PROJECT_A}/PEM_KEY as PEM_KEY` })
    const multiline = '-----BEGIN KEY-----\nline-one\nline-two\n-----END KEY-----'
    state.getSecretImpl = async () => multiline

    await run()

    const setSecretCalls = calls.filter((c) => c.fn === 'setSecret').map((c) => c.args[0])
    expect(setSecretCalls).toContain(multiline)
    expect(setSecretCalls).toContain('-----BEGIN KEY-----')
    expect(setSecretCalls).toContain('line-one')
    expect(setSecretCalls).toContain('line-two')
    expect(setSecretCalls).toContain('-----END KEY-----')

    const exportIdx = callOrder('exportVariable')
    const lastSetSecretIdx = calls.reduce((max, c, idx) => (c.fn === 'setSecret' ? idx : max), -1)
    expect(lastSetSecretIdx).toBeLessThan(exportIdx)
  })

  it('masks each line without a trailing carriage return for a CRLF multi-line secret', async () => {
    setInputs({ secrets: `${PROJECT_A}/PEM_KEY as PEM_KEY` })
    const crlfMultiline = '-----BEGIN KEY-----\r\nline-one\r\nline-two\r\n-----END KEY-----'
    state.getSecretImpl = async () => crlfMultiline

    await run()

    const setSecretCalls = calls.filter((c) => c.fn === 'setSecret').map((c) => c.args[0])
    expect(setSecretCalls).toContain('line-one')
    expect(setSecretCalls).toContain('line-two')
    expect(setSecretCalls).not.toContain('line-one\r')
    expect(setSecretCalls).not.toContain('line-two\r')
  })
})

describe("run() — scenario 14: typo'd continue-on-error value", () => {
  it('is caught and converted into a single clean setFailed call', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL`, 'continue-on-error': 'yes' })

    await run()

    expect(core.setFailed).toHaveBeenCalledTimes(1)
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid 'continue-on-error' value")
    )
    expect(createVaultAgent).not.toHaveBeenCalled()
  })
})

describe('run() — AC-5 edge case: invalid/revoked API key', () => {
  it('fails with an invalid-or-revoked-key message', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    state.getSecretImpl = async () => {
      throw new VaultAgentError(
        'token_exchange_failed',
        'Machine token exchange failed with HTTP 401'
      )
    }

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      "Failed to retrieve secret 'DATABASE_URL': invalid or revoked API key. Check that the api-key input is current and has not been revoked."
    )
  })
})

describe('run() — AC-9: ambiguous credential name and insufficient role', () => {
  it('surfaces the ambiguous-name remediation message', async () => {
    setInputs({ secrets: `${PROJECT_A}/API_KEY as API_KEY` })
    state.getSecretImpl = async () => {
      throw new VaultAgentError(
        'ambiguous_credential_name',
        'Multiple credentials named "API_KEY" exist'
      )
    }

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      "Failed to retrieve secret 'API_KEY': multiple credentials share this name in the project — machine-user retrieval requires unique names. Rename one of the duplicates in Project Vault before using it with vault-action."
    )
  })

  it('surfaces the insufficient-scope message', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    state.getSecretImpl = async () => {
      throw new VaultAgentError('insufficient_role', 'Access to "DATABASE_URL" is not permitted')
    }

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      `Failed to retrieve secret 'DATABASE_URL': the provided api-key is not authorized for project ${PROJECT_A}`
    )
  })
})

describe('run() — AC-6 edge case: empty-string secret value', () => {
  it('still exports an empty value rather than treating it as an error', async () => {
    setInputs({ secrets: `${PROJECT_A}/EMPTY as EMPTY_VAR` })
    state.getSecretImpl = async () => ''

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.exportVariable).toHaveBeenCalledWith('EMPTY_VAR', '')
  })
})

describe('run() — never logs the retrieved value via info/debug', () => {
  it('does not pass the secret value to core.info or core.debug', async () => {
    setInputs({ secrets: `${PROJECT_A}/DATABASE_URL as DB_URL` })
    state.getSecretImpl = async () => 'top-secret-value'

    await run()

    const infoAndDebugArgs = calls
      .filter((c) => c.fn === 'info' || c.fn === 'debug')
      .flatMap((c) => c.args)
    expect(infoAndDebugArgs.join(' ')).not.toContain('top-secret-value')
  })
})
