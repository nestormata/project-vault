/**
 * Story 43.5 Dev Notes decision #9 — the shared CLI-adapter preamble for every command that takes
 * repeatable `--secret NAME[=ENV_VAR]` flags with a machine-user key (`pvault run --`,
 * `pvault write-env`): zero-`--secret` check → `parseRunSecrets` → `looksLikeUuid` →
 * `warnAndCreateAgent`. Consolidated rather than repeated per command (jscpd is a hard CI gate, and
 * the two adapters must not drift on validation order or wording). Every check here runs before any
 * network call.
 */
import type { VaultAgent, VaultAgentConfig } from '@project-vault/agent'
import { warnAndCreateAgent, type ResolvedConfig } from './config.js'
import { EXIT_CODES } from './exit-codes.js'
import type { InjectEntry } from './fetch-secrets.js'
import type { WritableLike } from './get-command.js'
import { parseRunSecrets } from './parse-run-secrets.js'
import { sanitizeForTerminal } from './sanitize.js'
import { looksLikeUuid } from './validate.js'

export type SecretsCommandUsage = {
  /** The subcommand name, e.g. `run` or `write-env`. */
  commandName: string
  /** The one-line usage shown when no `--secret` flag was given. */
  usage: string
}

export type PreparedSecretsCommand =
  { ok: true; entries: InjectEntry[]; agent: VaultAgent } | { ok: false; exitCode: number }

export function prepareSecretsCommand(
  secrets: string[],
  usage: SecretsCommandUsage,
  config: ResolvedConfig,
  stderr: WritableLike,
  createVaultAgent: (config: VaultAgentConfig) => VaultAgent
): PreparedSecretsCommand {
  if (secrets.length === 0) {
    stderr.write(
      `pvault ${usage.commandName} requires at least one --secret flag. Usage: ${usage.usage}\n`
    )
    return { ok: false, exitCode: EXIT_CODES.secretsRequired }
  }

  const parsed = parseRunSecrets(secrets)
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n`)
    return { ok: false, exitCode: EXIT_CODES.usageError }
  }

  if (!looksLikeUuid(config.projectId)) {
    stderr.write(
      `Invalid project identifier — '${sanitizeForTerminal(config.projectId)}' must be the project's UUID, not its display name.\n`
    )
    return { ok: false, exitCode: EXIT_CODES.usageError }
  }

  const agent = warnAndCreateAgent(config, createVaultAgent, (chunk) => stderr.write(chunk))
  return { ok: true, entries: parsed.entries, agent }
}
