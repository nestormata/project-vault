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

describe('EXIT_CODES — Story 43.2 additions are distinct, exact integers', () => {
  it("every new session/login exit code is a distinct integer, not overlapping 43.1's 1-13 range", () => {
    const story432Codes = [
      EXIT_CODES.notLoggedIn,
      EXIT_CODES.sessionExpired,
      EXIT_CODES.invalidTotp,
      EXIT_CODES.mfaTokenExpired,
      EXIT_CODES.webauthnOnlyUnsupported,
      EXIT_CODES.insecureSessionFilePermissions,
      EXIT_CODES.nativeLoginDisabled,
      EXIT_CODES.invalidCredentials,
    ]
    expect(new Set(story432Codes).size).toBe(story432Codes.length)
    for (const code of story432Codes) {
      expect(code).toBeGreaterThan(EXIT_CODES.unexpected)
    }
    expect(story432Codes).toEqual([14, 15, 16, 17, 18, 19, 20, 21])
  })
})

describe('EXIT_CODES — Story 43.5 additions (append-only)', () => {
  it('pvault write-env codes are exactly 25-28, after every earlier block', () => {
    expect([
      EXIT_CODES.outputExists,
      EXIT_CODES.outputPathInvalid,
      EXIT_CODES.valueNotRepresentable,
      EXIT_CODES.outputWriteFailed,
    ]).toEqual([25, 26, 27, 28])
    const all = Object.values(EXIT_CODES)
    expect(new Set(all).size).toBe(all.length)
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
