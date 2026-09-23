import type { VaultAgent, VaultAgentConfig } from '@project-vault/agent'
import type { ResolvedConfig } from './config.js'
import { ENV_FILE_FORMATS, type EnvFileFormat } from './env-file-format.js'
import { EXIT_CODES } from './exit-codes.js'
import type { GetStreams } from './get-command.js'
import type { GitIgnoreStatus } from './git-ignore-check.js'
import { sanitizeForTerminal } from './sanitize.js'
import { prepareSecretsCommand } from './secrets-command-preamble.js'
import { writeEnvFile } from './write-env-file.js'

/**
 * Story 43.5 — the thin CLI adapter for `pvault write-env` (mirrors `run-command.ts`): flag-level
 * validation, the shared `--secret` preamble, then the AC-7 seam `writeEnvFile()`, mapping its
 * result to an exit code and the AC-4 success line. Knows nothing about the file format or the
 * write itself.
 */
export type WriteEnvArgs = {
  /** Raw `--secret` flag values (`NAME` or `NAME=ENV_VAR`). */
  secrets: string[]
  /** `--output`; required (Dev Notes decision #7: never a default path). */
  output: string | undefined
  force: boolean
  /** `--format`, unvalidated; must be exactly `dotenv` or `shell`. */
  format: string
}

export type WriteEnvDeps = {
  createVaultAgent: (config: VaultAgentConfig) => VaultAgent
  /** Base for a relative `--output`. */
  cwd: string
  checkGitIgnored?: (dir: string, name: string) => Promise<GitIgnoreStatus>
}

const USAGE =
  'pvault write-env --secret NAME[=ENV_VAR] --output <path> [--force] [--format dotenv|shell]'

function isEnvFileFormat(value: string): value is EnvFileFormat {
  return (ENV_FILE_FORMATS as readonly string[]).includes(value)
}

/** AC-4 — path and count only, never a value; the path is sanitized. */
export function successLine(result: {
  path: string
  count: number
  servedFromCacheCount: number
}): string {
  const noun = result.count === 1 ? 'secret' : 'secrets'
  const cacheSuffix =
    result.servedFromCacheCount > 0
      ? ` (${result.servedFromCacheCount} served from offline cache, may be stale)`
      : ''
  return `Wrote ${result.count} ${noun} to ${sanitizeForTerminal(result.path)}${cacheSuffix}\n`
}

/** Flag-level usage checks that need no config and no network. Returns an error line or null. */
function checkOutputAndFormat(args: WriteEnvArgs): string | null {
  if (!args.output) {
    return `pvault write-env requires --output <path>; secrets are never written to a default location. Usage: ${USAGE}`
  }
  if (args.output === '-') {
    return 'pvault write-env only writes files; --output - (stdout) is not supported. Use "pvault get" to print one secret, or "pvault run --" to inject secrets into a process.'
  }
  if (!isEnvFileFormat(args.format)) {
    return `Invalid --format '${sanitizeForTerminal(args.format)}'; valid values: ${ENV_FILE_FORMATS.join(', ')}`
  }
  return null
}

export async function runWriteEnv(
  args: WriteEnvArgs,
  config: ResolvedConfig,
  streams: GetStreams,
  deps: WriteEnvDeps
): Promise<number> {
  const usageError = checkOutputAndFormat(args)
  if (usageError) {
    streams.stderr.write(`${usageError}\n`)
    return EXIT_CODES.usageError
  }

  const prepared = prepareSecretsCommand(
    args.secrets,
    { commandName: 'write-env', usage: USAGE },
    config,
    streams.stderr,
    deps.createVaultAgent
  )
  if (!prepared.ok) return prepared.exitCode
  const { entries, agent } = prepared

  const result = await writeEnvFile(
    entries,
    args.output as string,
    { format: args.format as EnvFileFormat, force: args.force },
    {
      getSecret: (name, context) => agent.getSecret(name, context),
      writeStderr: (chunk) => streams.stderr.write(chunk),
      cwd: deps.cwd,
      checkGitIgnored: deps.checkGitIgnored,
    }
  )

  streams.stderr.write(result.ok ? successLine(result) : `${result.error}\n`)
  return result.exitCode
}
