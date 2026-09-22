import { describe, expect, it } from 'vitest'
import { CliUsageError, EXIT_CODES, exitCodeForAgentErrorCode } from './exit-codes.js'

describe('exitCodeForAgentErrorCode', () => {
  // Dev Notes decision #4 — every one of packages/agent's actual VaultAgentError .code values
  // (read directly from packages/agent/src/errors.ts) must map to its own distinct exit code.
  const cases: Array<[string, number]> = [
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
  ]

  it.each(cases)('maps %s to exit code %i', (code, expected) => {
    expect(exitCodeForAgentErrorCode(code)).toBe(expected)
  })

  it('every mapped exit code is distinct (AC-5 "distinguishable" requirement)', () => {
    const codes = cases.map(([code]) => exitCodeForAgentErrorCode(code))
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('falls back to the generic "unexpected" exit code for an unrecognized .code', () => {
    expect(exitCodeForAgentErrorCode('some_future_code_not_yet_known')).toBe(EXIT_CODES.unexpected)
  })

  it('the usage-error and unexpected-error exit codes are distinct from every mapped agent-error code', () => {
    const mapped = new Set(cases.map(([, code]) => code))
    expect(mapped.has(EXIT_CODES.usageError)).toBe(false)
    expect(mapped.has(EXIT_CODES.unexpected)).toBe(false)
  })
})

describe('CliUsageError', () => {
  it('carries a message and is a real Error instance', () => {
    const err = new CliUsageError('missing VAULT_API_KEY')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('missing VAULT_API_KEY')
    expect(err.name).toBe('CliUsageError')
  })
})
