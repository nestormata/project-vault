import type { VaultAgent, VaultAgentConfig } from '@project-vault/agent'
import { warnAndCreateAgent, type ResolvedConfig } from './config.js'
import { EXIT_CODES } from './exit-codes.js'
import type { GetStreams } from './get-command.js'
import { injectAndRun, type ParentProcessLike, type SpawnFn } from './inject-and-run.js'
import { parseRunSecrets } from './parse-run-secrets.js'
import { sanitizeForTerminal } from './sanitize.js'
import { looksLikeUuid } from './validate.js'

/**
 * Story 43.3 AC-5 / Dev Notes decision #6 — the opt-in gate, isolated into its own small function
 * so Story 43.4 (which removes this AC once its hardening ships) can delete one function call and
 * its supporting flag/message cleanly, rather than a check scattered across multiple call sites.
 *
 * Deliberately CLI-argument-only (`--allow-unhardened-injection`) — no env var fallback — so the
 * opt-in stays a conscious, per-invocation act during the gated interval (never a permanent,
 * forgotten shell-profile default).
 */
const RESIDUAL_RISK =
  'pvault run -- injects secrets into a process whose own crash dumps, stack traces, or /proc/<pid>/environ could leak them'

export function requireUnhardenedInjectionOptIn(
  allowUnhardenedInjection: boolean,
  writeStderr: (chunk: string) => void
): boolean {
  if (!allowUnhardenedInjection) {
    writeStderr(
      `${RESIDUAL_RISK} — this protection ships in a future release. Pass --allow-unhardened-injection to proceed anyway.\n`
    )
    return false
  }
  // Printed on EVERY invocation (never "warn once") — a developer scripting this flag into a
  // Makefile target should see the warning on every run until Story 43.4 ships.
  writeStderr(`warning: ${RESIDUAL_RISK}.\n`)
  return true
}

export type RunArgs = {
  /** Raw `--secret` flag values, exactly as passed (e.g. `NAME` or `NAME=ENV_VAR`). */
  secrets: string[]
  command: string
  commandArgs: string[]
  allowUnhardenedInjection: boolean
}

export type RunDeps = {
  createVaultAgent: (config: VaultAgentConfig) => VaultAgent
  spawn: SpawnFn
  parentProcess: ParentProcessLike
  /** The base environment the child inherits, layered with the injected vars on top. */
  env: NodeJS.ProcessEnv
}

/**
 * Orchestrates the full `pvault run --secret ... -- <command>` flow (AC-1 through AC-5). Thin CLI
 * adapter over `inject-and-run.ts`'s AC-6 seam — this module is the one place that knows about
 * `pvault run`'s own flag shapes; `injectAndRun()` itself has no idea any of this is a CLI at all.
 */
export async function runRun(
  args: RunArgs,
  config: ResolvedConfig,
  streams: GetStreams,
  deps: RunDeps
): Promise<number> {
  // AC-5 — checked first, before any other validation: the opt-in gate is the primary security
  // control for the unhardened interval between this story and Story 43.4.
  if (
    !requireUnhardenedInjectionOptIn(args.allowUnhardenedInjection, (chunk) =>
      streams.stderr.write(chunk)
    )
  ) {
    return EXIT_CODES.unhardenedInjectionNotAcknowledged
  }

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
    getSecret: (name) => agent.getSecret(name),
    spawn: deps.spawn,
    parentProcess: deps.parentProcess,
    baseEnv: deps.env,
    writeStderr: (chunk) => streams.stderr.write(chunk),
  })

  if (!result.ok) {
    streams.stderr.write(`${result.error}\n`)
  }
  return result.exitCode
}
