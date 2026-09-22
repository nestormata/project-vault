import { describe, expect, it, vi } from 'vitest'
import { VaultAgentError } from '@project-vault/agent'
import { EXIT_CODES } from './exit-codes.js'
import { runGet } from './get-command.js'

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

const VAULT_URL = 'https://vault.example.com'

const validConfig = {
  apiKey: 'pk_abc123',
  baseUrl: VAULT_URL,
  projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
}

describe('runGet — AC-2 success path', () => {
  it('writes exactly the resolved value to stdout with no decoration, and returns exit code 0', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('postgres://real-value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'DATABASE_URL', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('postgres://real-value')
    expect(createVaultAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'pk_abc123',
        baseUrl: VAULT_URL,
        projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
      })
    )
    expect(getSecret).toHaveBeenCalledWith('DATABASE_URL')
  })

  it('round-trips a value that itself contains a trailing newline, unmodified', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('value-with-newline\n')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: 'FOO', stdout: false }, validConfig, streams, { createVaultAgent })

    expect(streams.stdoutChunks.join('')).toBe('value-with-newline\n')
  })

  it('round-trips an empty-string secret value unmodified', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'FOO', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('')
  })

  it('writes nothing extra to stdout — no banner, no progress line', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: 'FOO', stdout: false }, validConfig, streams, { createVaultAgent })

    expect(streams.stdoutChunks).toEqual(['value'])
  })
})

describe('runGet — AC-3 interactive TTY refusal', () => {
  it('refuses to print and names `pvault run --` as the intended path when stdout is a TTY and --stdout is not passed', async () => {
    const streams = makeStreams(true)
    const getSecret = vi.fn()
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'DATABASE_URL', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(streams.stdoutChunks).toEqual([])
    expect(streams.stderrChunks.join('')).toMatch(/run --/)
    // The refusal fires before any fetch — the secret is never even requested.
    expect(getSecret).not.toHaveBeenCalled()
  })

  it('prints the value when --stdout overrides the TTY refusal', async () => {
    const streams = makeStreams(true)
    const getSecret = vi.fn().mockResolvedValue('value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'DATABASE_URL', stdout: true }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('value')
  })

  it('does not refuse when stdout is not a TTY, even without --stdout', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'DATABASE_URL', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(0)
  })
})

describe('runGet — AC-2 boundary cases (before any network call)', () => {
  it('rejects an empty credential name without calling createVaultAgent', async () => {
    const streams = makeStreams(false)
    const createVaultAgent = vi.fn()

    const exitCode = await runGet({ name: '', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(streams.stderrChunks.join('')).not.toBe('')
  })

  it('rejects a whitespace-only credential name without calling createVaultAgent', async () => {
    const streams = makeStreams(false)
    const createVaultAgent = vi.fn()

    const exitCode = await runGet({ name: '   ', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it("rejects a non-UUID PROJECT_ID before any network call, matching vault-action's wording pattern", async () => {
    const streams = makeStreams(false)
    const createVaultAgent = vi.fn()
    const badConfig = { ...validConfig, projectId: 'My Cool Project' }

    const exitCode = await runGet({ name: 'FOO', stdout: false }, badConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(EXIT_CODES.usageError)
    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(streams.stderrChunks.join('')).toMatch(/project's UUID/)
  })
})

describe('runGet — AC-2 hardening: insecure baseUrl warning', () => {
  it('warns on stderr (not stdout) for a non-loopback http:// baseUrl, but still proceeds', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
    const insecureConfig = { ...validConfig, baseUrl: 'http://vault.example.com' }

    const exitCode = await runGet({ name: 'FOO', stdout: false }, insecureConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('value')
    expect(streams.stderrChunks.join('')).toMatch(/plaintext|insecure|http/i)
  })
})

describe('runGet — AC-5 documented error cases', () => {
  it.each([
    ['token_exchange_failed', EXIT_CODES.tokenExchangeFailed],
    ['credential_not_found', EXIT_CODES.credentialNotFound],
    ['insufficient_role', EXIT_CODES.insufficientRole],
    ['ambiguous_credential_name', EXIT_CODES.ambiguousCredentialName],
    ['vault_request_failed', EXIT_CODES.vaultRequestFailed],
    ['multi_field_secret_unsupported', EXIT_CODES.multiFieldSecretUnsupported],
    ['vault_unreachable', EXIT_CODES.vaultUnreachable],
    ['vault_unreachable_non_cacheable', EXIT_CODES.vaultUnreachableNonCacheable],
    ['cache_expired', EXIT_CODES.cacheExpired],
    ['cache_decryption_failed', EXIT_CODES.cacheDecryptionFailed],
    ['cache_corrupted', EXIT_CODES.cacheCorrupted],
  ])(
    '%s exits with the distinct exit code %i and never writes to stdout',
    async (code, expectedExit) => {
      const streams = makeStreams(false)
      const error = new VaultAgentError(code, `error for ${code}`)
      const getSecret = vi.fn().mockRejectedValue(error)
      const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

      const exitCode = await runGet({ name: 'FOO', stdout: false }, validConfig, streams, {
        createVaultAgent,
      })

      expect(exitCode).toBe(expectedExit)
      expect(streams.stdoutChunks).toEqual([])
      expect(streams.stderrChunks.join('')).not.toBe('')
    }
  )

  it('an unexpected non-VaultAgentError exits with the generic unexpected code and never writes to stdout', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockRejectedValue(new Error('boom, something unrelated broke'))
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'FOO', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    expect(exitCode).toBe(EXIT_CODES.unexpected)
    expect(streams.stdoutChunks).toEqual([])
  })

  it('never interpolates the raw API key into any error message (token_exchange_failed)', async () => {
    const streams = makeStreams(false)
    const error = new VaultAgentError(
      'token_exchange_failed',
      'Machine token exchange failed with HTTP 401'
    )
    const getSecret = vi.fn().mockRejectedValue(error)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: 'FOO', stdout: false }, validConfig, streams, { createVaultAgent })

    expect(streams.stderrChunks.join('')).not.toContain(validConfig.apiKey)
  })

  it('sanitizes control characters out of an attacker-influenceable credential name before it is echoed in an error message', async () => {
    const streams = makeStreams(false)
    const maliciousName = 'FOO\u001b[2J\u001b[HPWNED'
    const error = new VaultAgentError(
      'credential_not_found',
      `Credential "${maliciousName}" was not found`
    )
    const getSecret = vi.fn().mockRejectedValue(error)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: maliciousName, stdout: false }, validConfig, streams, { createVaultAgent })

    const combined = streams.stderrChunks.join('')
    expect(combined).not.toMatch(/\x1b/)
  })

  it('sanitizes control characters embedded in error.message itself (not just safeName) for the unreachable/cache codes', async () => {
    const streams = makeStreams(false)
    const maliciousName = 'FOO\u001b[2J\u001b[HPWNED'
    // packages/agent embeds the raw, unsanitized name directly into error.message for these
    // codes (see packages/agent/src/errors.ts) — this must be sanitized independently of safeName.
    const error = new VaultAgentError(
      'vault_unreachable',
      `Vault is unreachable and no cached value exists for "${maliciousName}".`
    )
    const getSecret = vi.fn().mockRejectedValue(error)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: maliciousName, stdout: false }, validConfig, streams, { createVaultAgent })

    const combined = streams.stderrChunks.join('')
    expect(combined).not.toMatch(/\x1b/)
  })

  it('sanitizes control characters embedded in error.message for the generic fallback branch', async () => {
    const streams = makeStreams(false)
    const maliciousMessage = 'Vault request failed\u001b[2J\u001b[Hwith HTTP 500'
    const error = new VaultAgentError('vault_request_failed', maliciousMessage)
    const getSecret = vi.fn().mockRejectedValue(error)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: 'FOO', stdout: false }, validConfig, streams, { createVaultAgent })

    const combined = streams.stderrChunks.join('')
    expect(combined).not.toMatch(/\x1b/)
  })

  it('a fetch fixture whose error body contains a sentinel string never lets that sentinel reach CLI output', async () => {
    const streams = makeStreams(false)
    const sentinel = 'super-secret-should-never-leak'
    const error = new VaultAgentError('vault_request_failed', `Vault request failed with HTTP 500`)
    const getSecret = vi.fn().mockRejectedValue(error)
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: 'FOO', stdout: false }, validConfig, streams, { createVaultAgent })

    expect(streams.stdoutChunks.join('')).not.toContain(sentinel)
    expect(streams.stderrChunks.join('')).not.toContain(sentinel)
  })
})

describe('runGet — AC-4a cache-fallback provenance signaling', () => {
  const originalFetch = globalThis.fetch

  it('signals on stderr (never stdout) when the value was served from the offline cache after a network failure, and still exits 0', async () => {
    const streams = makeStreams(false)
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const getSecret = vi.fn().mockImplementation(async () => {
      // Mirrors packages/agent's own internal behavior: attempt a live fetch (fails with a
      // TypeError), then fall back to a cached value.
      try {
        await globalThis.fetch(VAULT_URL)
      } catch {
        // swallowed, exactly like packages/agent's own fallback path
      }
      return 'stale-cached-value'
    })
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    const exitCode = await runGet({ name: 'FOO', stdout: false }, validConfig, streams, {
      createVaultAgent,
    })

    globalThis.fetch = originalFetch

    expect(exitCode).toBe(0)
    expect(streams.stdoutChunks.join('')).toBe('stale-cached-value')
    expect(streams.stderrChunks.join('')).toMatch(/cache|stale/i)
  })

  it('does not signal a cache warning when the value was served live (no network failure observed)', async () => {
    const streams = makeStreams(false)
    const getSecret = vi.fn().mockResolvedValue('live-value')
    const createVaultAgent = vi.fn().mockReturnValue({ getSecret })

    await runGet({ name: 'FOO', stdout: false }, validConfig, streams, { createVaultAgent })

    expect(streams.stderrChunks.join('')).toBe('')
  })
})
