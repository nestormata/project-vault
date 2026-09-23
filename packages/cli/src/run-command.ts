import type { VaultAgent, VaultAgentConfig } from '@project-vault/agent'
import { warnAndCreateAgent, type ResolvedConfig } from './config.js'
import { EXIT_CODES } from './exit-codes.js'
import type { GetStreams } from './get-command.js'
import { injectAndRun, type ParentProcessLike, type SpawnFn } from './inject-and-run.js'
import { parseRunSecrets } from './parse-run-secrets.js'
import { sanitizeForTerminal } from './sanitize.js'
import { looksLikeUuid } from './validate.js'

export type RunArgs = {
  /** Raw `--secret` flag values, exactly as passed (e.g. `NAME` or `NAME=ENV_VAR`). */
  secrets: string[]
  command: string
  commandArgs: string[]
  /** Story 43.4 AC-2 — deliver secrets as one JSON object on FD 3 instead of as env vars. */
  secretsFd: boolean
}

export type RunDeps = {
  createVaultAgent: (config: VaultAgentConfig) => VaultAgent
  spawn: SpawnFn
  parentProcess: ParentProcessLike
  /** The base environment the child inherits, layered with the injected vars on top. */
  env: NodeJS.ProcessEnv
}

/**
 * Orchestrates the full `pvault run --secret ... -- <command>` flow. Thin CLI adapter over
 * `inject-and-run.ts`'s AC-6 seam — this module is the one place that knows about `pvault run`'s
 * own flag shapes; `injectAndRun()` itself has no idea any of this is a CLI at all.
 *
 * Story 43.4 AC-4 — Story 43.3's `--allow-unhardened-injection` opt-in gate (and its
 * per-invocation residual-risk warning) is removed: `pvault run --` is generally available. The
 * residual-risk disclosure now lives once in packages/cli/README.md. Every Story 43.4 hardening
 * (FD delivery, audit context, `VAULT_API_KEY` strip) lives in the seam, not here (AC-5).
 */
export async function runRun(
  args: RunArgs,
  config: ResolvedConfig,
  streams: GetStreams,
  deps: RunDeps
): Promise<number> {
  // AC-1 edge case — zero `--secret` flags defeats the entire point of this command.
  if (args.secrets.length === 0) {
    streams.stderr.write(
      'pvault run requires at least one --secret flag. Usage: pvault run --secret NAME -- <command> [args...]\n'
    )
    return EXIT_CODES.secretsRequired
  }

  const parsed = parseRunSecrets(args.secrets)
  if (!parsed.ok) {
    streams.stderr.write(`${parsed.error}\n`)
    return EXIT_CODES.usageError
  }

  if (!looksLikeUuid(config.projectId)) {
    streams.stderr.write(
      `Invalid project identifier — '${sanitizeForTerminal(config.projectId)}' must be the project's UUID, not its display name.\n`
    )
    return EXIT_CODES.usageError
  }

  const agent = warnAndCreateAgent(config, deps.createVaultAgent, (chunk) =>
    streams.stderr.write(chunk)
  )

  const result = await injectAndRun(parsed.entries, args.command, args.commandArgs, {
    getSecret: (name, context) => agent.getSecret(name, context),
    spawn: deps.spawn,
    parentProcess: deps.parentProcess,
    baseEnv: deps.env,
    writeStderr: (chunk) => streams.stderr.write(chunk),
    delivery: args.secretsFd ? 'fd' : 'env',
  })

  if (!result.ok) {
    streams.stderr.write(`${result.error}\n`)
  }
  return result.exitCode
}
