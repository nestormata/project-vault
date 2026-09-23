import { VaultAgentError } from '@project-vault/agent'
import { sanitizeForTerminal } from './sanitize.js'

/**
 * Extracted from `get-command.ts` (Story 43.1) so `run-command.ts`/`inject-and-run.ts` (Story
 * 43.3) can share the exact same per-`VaultAgentError`-code message wording — Story 43.3's Dev
 * Notes decision #3 explicitly requires not letting `get` and `run` diverge in wording for the
 * same underlying error code.
 */

const UNREACHABLE_CODES = new Set([
  'vault_unreachable',
  'vault_unreachable_non_cacheable',
  'cache_expired',
  'cache_decryption_failed',
  'cache_corrupted',
])

type MessageBuilder = (safeName: string) => string

const MESSAGE_BUILDERS: ReadonlyMap<string, MessageBuilder> = new Map<string, MessageBuilder>([
  [
    'token_exchange_failed',
    () =>
      'Invalid or revoked API key. Check that VAULT_API_KEY is current and has not been revoked.',
  ],
  ['credential_not_found', (safeName) => `Credential '${safeName}' was not found in this project.`],
  ['insufficient_role', (safeName) => `Access to '${safeName}' is not permitted for this project.`],
  [
    'ambiguous_credential_name',
    (safeName) =>
      `Multiple credentials named '${safeName}' exist in this project — machine-user retrieval requires unique names. Rename one of the duplicates in Project Vault.`,
  ],
  [
    'multi_field_secret_unsupported',
    (safeName) =>
      `'${safeName}' is a multi-field secret; 'pvault get' can only fetch single-value secrets. Use the HTTP API directly with ?field=<key> (see docs/machine-users.md).`,
  ],
])

/** Per-code message builders for AC-5's mapping table, mirroring
 * packages/vault-action/src/classify.ts's perEntryMessage() wording pattern (reused, not
 * reinvented — see Story 43.1's Dev Notes "Architecture & prior art"). Shared between `pvault get`
 * and `pvault run --` (Story 43.3 Dev Notes decision #3) so the two never diverge in wording. */
export function messageForAgentError(error: VaultAgentError, safeName: string): string {
  // `error.message` (from packages/agent) can itself embed the raw, unsanitized credential name
  // for several codes (see packages/agent/src/errors.ts) — sanitize it too, not just `safeName`,
  // so the terminal-escape-injection hardening (AC-5) isn't bypassed via this second echo path.
  const safeErrorMessage = sanitizeForTerminal(error.message)
  if (UNREACHABLE_CODES.has(error.code)) {
    return `Vault is unreachable and no usable cached value exists for '${safeName}': ${safeErrorMessage}`
  }
  const build = MESSAGE_BUILDERS.get(error.code)
  if (build) return build(safeName)
  return `Failed to retrieve secret '${safeName}': ${safeErrorMessage}`
}
