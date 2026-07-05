import { VaultAgentError } from '@project-vault/agent'
import { VaultActionTimeoutError } from './with-timeout.js'

/**
 * D4 — error codes representing "the vault could not be reached at all" (or an offline cache
 * that was only ever consulted because the vault was unreachable) — the only failure class
 * `continue-on-error` can soften. Every other `VaultAgentError` code represents a live server
 * response and always hard-fails, regardless of `continue-on-error` (AC-9).
 */
const VAULT_UNREACHABLE_CODES = new Set([
  'vault_unreachable',
  'vault_unreachable_non_cacheable',
  'cache_expired',
  'cache_decryption_failed',
  'cache_corrupted',
  'vault_action_timeout',
])

export function isVaultUnreachable(error: unknown): boolean {
  if (error instanceof VaultActionTimeoutError) return true
  if (error instanceof VaultAgentError) return VAULT_UNREACHABLE_CODES.has(error.code)
  return false
}

export type ReasonToken =
  | 'vault unreachable'
  | 'invalid api-key'
  | 'not found'
  | 'ambiguous name'
  | 'insufficient scope'
  | 'request failed'

export function reasonTokenFor(error: unknown): ReasonToken {
  if (isVaultUnreachable(error)) return 'vault unreachable'
  if (error instanceof VaultAgentError) {
    switch (error.code) {
      case 'token_exchange_failed':
        return 'invalid api-key'
      case 'credential_not_found':
        return 'not found'
      case 'ambiguous_credential_name':
        return 'ambiguous name'
      case 'insufficient_role':
        return 'insufficient scope'
      default:
        return 'request failed'
    }
  }
  return 'request failed'
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function looksLikeUuid(value: string): boolean {
  return UUID_REGEX.test(value)
}

/**
 * Builds the verbose, per-entry failure message (AC-5, AC-7, AC-8, AC-9) for a single
 * `getSecret()` failure. `projectId` is the single validated (lowercase-normalized) project id
 * for this invocation (D2).
 */
export function perEntryMessage(
  credentialName: string,
  projectId: string,
  vaultUrl: string,
  error: unknown
): string {
  if (isVaultUnreachable(error)) {
    return `Failed to retrieve secret '${credentialName}': vault at ${vaultUrl} is unreachable`
  }
  if (error instanceof VaultAgentError) {
    switch (error.code) {
      case 'token_exchange_failed':
        return `Failed to retrieve secret '${credentialName}': invalid or revoked API key. Check that the api-key input is current and has not been revoked.`
      case 'credential_not_found':
        return `Failed to retrieve secret '${credentialName}': credential not found in project ${projectId}`
      case 'ambiguous_credential_name':
        return `Failed to retrieve secret '${credentialName}': multiple credentials share this name in the project — machine-user retrieval requires unique names. Rename one of the duplicates in Project Vault before using it with vault-action.`
      case 'insufficient_role':
        return `Failed to retrieve secret '${credentialName}': the provided api-key is not authorized for project ${projectId}`
      default:
        // AC-4 edge case: a non-UUID PROJECT segment is passed through as-is and rejected by the
        // vault's route-param schema layer; the agent surfaces that as a generic, undifferentiated
        // request failure (no dedicated error code exists for it), so this is detected client-side
        // from the projectId shape we already validated locally.
        if (!looksLikeUuid(projectId)) {
          return `Failed to retrieve secret '${credentialName}': invalid project identifier — '${projectId}' must be the project's UUID, not its display name`
        }
        return `Failed to retrieve secret '${credentialName}': ${error.message}`
    }
  }
  return `Failed to retrieve secret '${credentialName}': ${error instanceof Error ? error.message : String(error)}`
}
