import { VaultAgentError, type VaultAgent, type VaultAgentConfig } from '@project-vault/agent'
import { messageForAgentError } from './agent-error-messages.js'
import { withFetchProvenanceTracking } from './cache-provenance.js'
import { warnAndCreateAgent, type ResolvedConfig } from './config.js'
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
  const agent = warnAndCreateAgent(config, deps.createVaultAgent, (chunk) =>
    streams.stderr.write(chunk)
  )

  try {
    // Dev Notes decision #5 / AC-4a — participates in packages/agent's default offline-cache
    // fallback, but signals on stderr when the resolved value was actually served from cache.
    // Story 43.4 AC-3 / decision #2 — `invocation: 'get'` lets the audit trail tell "a value was
    // printed" apart from "a value was handed to a child process" (`run`).
    const { result: value, servedAfterNetworkFailure } = await withFetchProvenanceTracking(() =>
      agent.getSecret(args.name, { invocation: 'get' })
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
