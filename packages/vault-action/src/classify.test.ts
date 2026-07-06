import { describe, expect, it } from 'vitest'
import {
  VaultAgentError,
  VaultUnreachableError,
  VaultCacheExpiredError,
} from '@project-vault/agent'
import { isVaultUnreachable, looksLikeUuid, perEntryMessage, reasonTokenFor } from './classify.js'
import { VaultActionTimeoutError } from './with-timeout.js'

describe('isVaultUnreachable', () => {
  it('is true for VaultUnreachableError, VaultCacheExpiredError, and VaultActionTimeoutError', () => {
    expect(isVaultUnreachable(new VaultUnreachableError('X'))).toBe(true)
    expect(isVaultUnreachable(new VaultCacheExpiredError('X'))).toBe(true)
    expect(isVaultUnreachable(new VaultActionTimeoutError())).toBe(true)
  })

  it('is false for application-level VaultAgentError codes', () => {
    expect(isVaultUnreachable(new VaultAgentError('credential_not_found', 'nope'))).toBe(false)
    expect(isVaultUnreachable(new VaultAgentError('insufficient_role', 'nope'))).toBe(false)
    expect(isVaultUnreachable(new VaultAgentError('ambiguous_credential_name', 'nope'))).toBe(false)
    expect(isVaultUnreachable(new VaultAgentError('token_exchange_failed', 'nope'))).toBe(false)
  })

  it('is false for a plain, unrelated error', () => {
    expect(isVaultUnreachable(new Error('unrelated'))).toBe(false)
  })
})

describe('reasonTokenFor', () => {
  it.each([
    [new VaultUnreachableError('X'), 'vault unreachable'],
    [new VaultAgentError('token_exchange_failed', 'x'), 'invalid api-key'],
    [new VaultAgentError('credential_not_found', 'x'), 'not found'],
    [new VaultAgentError('ambiguous_credential_name', 'x'), 'ambiguous name'],
    [new VaultAgentError('insufficient_role', 'x'), 'insufficient scope'],
    [new VaultAgentError('vault_request_failed', 'x'), 'request failed'],
  ] as const)('maps %#', (error, expected) => {
    expect(reasonTokenFor(error)).toBe(expected)
  })
})

describe('looksLikeUuid', () => {
  it('accepts a well-formed UUID regardless of case', () => {
    expect(looksLikeUuid('a1c2d3e4-0000-0000-0000-000000000000')).toBe(true)
    expect(looksLikeUuid('A1C2D3E4-0000-0000-0000-000000000000')).toBe(true)
  })

  it('rejects a human-readable slug', () => {
    expect(looksLikeUuid('my-project')).toBe(false)
  })
})

describe('perEntryMessage', () => {
  const VAULT_URL = 'https://vault.example.com'
  const PROJECT = 'a1c2d3e4-0000-0000-0000-000000000000'

  it('formats a vault-unreachable message', () => {
    const message = perEntryMessage(
      'DATABASE_URL',
      PROJECT,
      VAULT_URL,
      new VaultUnreachableError('DATABASE_URL')
    )
    expect(message).toBe(
      `Failed to retrieve secret 'DATABASE_URL': vault at ${VAULT_URL} is unreachable`
    )
  })

  it('formats a generic request-failed message with the invalid-project hint for a non-UUID project', () => {
    const message = perEntryMessage(
      'DATABASE_URL',
      'my-project',
      VAULT_URL,
      new VaultAgentError('vault_request_failed', 'Vault request failed with HTTP 400')
    )
    expect(message).toBe(
      "Failed to retrieve secret 'DATABASE_URL': invalid project identifier — 'my-project' must be the project's UUID, not its display name"
    )
  })

  it('falls back to the underlying error message for an unrecognized code on a valid UUID project', () => {
    const message = perEntryMessage(
      'DATABASE_URL',
      PROJECT,
      VAULT_URL,
      new VaultAgentError('vault_request_failed', 'Vault request failed with HTTP 500')
    )
    expect(message).toBe(
      "Failed to retrieve secret 'DATABASE_URL': Vault request failed with HTTP 500"
    )
  })
})
