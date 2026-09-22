import { VaultAgentError, type VaultAgent, type VaultAgentConfig } from '@project-vault/agent'
import { withFetchProvenanceTracking } from './cache-provenance.js'
import { warnIfInsecureBaseUrl, type ResolvedConfig } from './config.js'
import { exitCodeForAgentErrorCode, EXIT_CODES } from './exit-codes.js'
import { sanitizeForTerminal } from './sanitize.js'
import { isBlank, looksLikeUuid } from './validate.js'

export type GetArgs = {
  name: string
  /** AC-3 — the interactive-print override flag (Dev Notes decision #3). */
  stdout: boolean
}

export type WritableLike = { write: (chunk: string) => void }

export type GetStreams = {
  stdout: WritableLike
  stderr: WritableLike
  isTTY: boolean
}

export type GetDeps = {
  createVaultAgent: (config: VaultAgentConfig) => VaultAgent
}

const UNREACHABLE_CODES = new Set([
  'vault_unreachable',
  'vault_unreachable_non_cacheable',
  'cache_expired',
  'cache_decryption_failed',
  'cache_corrupted',
])

/** Per-code message builders for AC-5's mapping table, mirroring
 * packages/vault-action/src/classify.ts's perEntryMessage() wording pattern (reused, not
 * reinvented — see this story's Dev Notes "Architecture & prior art"). A Map keeps this a flat
 * lookup instead of a long switch/if-chain. */
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

function messageForAgentError(error: VaultAgentError, safeName: string): string {
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

/**
 * Orchestrates the full `pvault get <name>` flow (AC-2 through AC-6, AC-4a). Returns the process
 * exit code rather than calling `process.exit()` itself, so the caller controls when the process
 * actually terminates (letting stdout/stderr flush first) and so this function stays trivially
 * unit-testable with fake streams and a fake agent factory.
 */
export async function runGet(
  args: GetArgs,
  config: ResolvedConfig,
  streams: GetStreams,
  deps: GetDeps
): Promise<number> {
  // AC-2 boundary case — reject an empty/whitespace-only name locally, before any network call.
  if (isBlank(args.name)) {
    streams.stderr.write('Credential name must not be empty.\n')
    return EXIT_CODES.usageError
  }

  const safeName = sanitizeForTerminal(args.name)

  // AC-2 boundary case — reject a non-UUID project id locally (ported from
  // packages/vault-action/src/classify.ts's looksLikeUuid() check), before any network call.
  if (!looksLikeUuid(config.projectId)) {
    streams.stderr.write(
      `Invalid project identifier — '${sanitizeForTerminal(config.projectId)}' must be the project's UUID, not its display name.\n`
    )
    return EXIT_CODES.usageError
  }

  // AC-3 — the refusal happens before getSecret() is ever called, so the secret value never
  // exists in scope at the point of refusal.
  if (streams.isTTY && !args.stdout) {
    streams.stderr.write(
      'Refusing to print a secret to an interactive terminal. Use `pvault run -- <command>` to inject it into a process instead, or pass --stdout to print anyway.\n'
    )
    return EXIT_CODES.usageError
  }

  // AC-2 hardening — a defensive, non-blocking warning; never a hard failure.
  warnIfInsecureBaseUrl(config.baseUrl, (chunk) => streams.stderr.write(chunk))

  const agent = deps.createVaultAgent({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    projectId: config.projectId,
  })

  try {
    // Dev Notes decision #5 / AC-4a — participates in packages/agent's default offline-cache
    // fallback, but signals on stderr when the resolved value was actually served from cache.
    const { result: value, servedAfterNetworkFailure } = await withFetchProvenanceTracking(() =>
      agent.getSecret(args.name)
    )

    if (servedAfterNetworkFailure) {
      streams.stderr.write(
        `warning: served from offline cache (vault unreachable), value may be stale\n`
      )
    }

    // AC-4 — the value itself, with nothing added or removed, on the one intended success path.
    streams.stdout.write(value)
    return 0
  } catch (error) {
    if (error instanceof VaultAgentError) {
      streams.stderr.write(`${messageForAgentError(error, safeName)}\n`)
      return exitCodeForAgentErrorCode(error.code)
    }
    // AC-6 edge case — an unexpected error path must never have the secret value in scope; it
    // never was in scope here, since this catch only runs when getSecret() itself rejected.
    const message = error instanceof Error ? error.message : String(error)
    streams.stderr.write(`Unexpected error: ${sanitizeForTerminal(message)}\n`)
    return EXIT_CODES.unexpected
  }
}
