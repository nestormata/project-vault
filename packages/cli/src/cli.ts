import { Command } from 'commander'
import {
  createVaultAgent as realCreateVaultAgent,
  type VaultAgent,
  type VaultAgentConfig,
} from '@project-vault/agent'
import { CliUsageError, EXIT_CODES } from './exit-codes.js'
import { resolveConfig, resolveLoginConfig } from './config.js'
import { runGet, type GetStreams, type WritableLike } from './get-command.js'
import { runLogin } from './login-command.js'
import { runLogout } from './logout-command.js'
import { createRealPrompt, type PromptFn } from './prompt.js'

// Dev Notes decision #6 — CLI argument-parsing/command framework: commander (already resolved
// elsewhere in this monorepo's lockfile), a real subcommand framework rather than hand-rolled
// `process.argv` parsing, chosen because this is the first story of a six-story epic whose later
// stories (`login`, `run -- <cmd>`, `.env` materialization, a startup version check) all add more
// multi-command, multi-flag surface. See packages/cli/README.md.

export type CliRuntime = {
  streams: GetStreams
  env: Record<string, string | undefined>
  createVaultAgent: (config: VaultAgentConfig) => VaultAgent
  setExitCode: (code: number) => void
  /** Story 43.2 Dev Notes decision #3 — the interactive-prompt seam `login` needs. */
  prompt: PromptFn
  /** Story 43.2 Dev Notes decision #2 — `login`/`logout` talk to the new auth endpoints directly
   * via `fetch`, independent of `@project-vault/agent` (a human session is a different token type
   * than a machine-user key — see that decision's scope-boundary note). */
  fetchFn: typeof fetch
}

const PACKAGE_VERSION = '0.0.1'

export function buildProgram(runtime: CliRuntime): Command {
  const program = new Command()
  program
    .name('pvault')
    .description(
      'Project Vault CLI — fetch and inject secrets from the terminal using a machine-user API key.'
    )
    .version(PACKAGE_VERSION)
    // Never let commander call process.exit() itself — this library is used both as a real
    // binary (bin.ts controls the real exit) and in-process by tests via parseAsync().
    .exitOverride()
    .configureOutput({
      writeOut: (str) => runtime.streams.stdout.write(str),
      writeErr: (str) => runtime.streams.stderr.write(str),
    })

  program
    .command('get')
    .description(
      'Fetch a single secret by name and write its value to stdout (AC-3: opt-in to print).'
    )
    .argument('<name>', 'the credential name to fetch')
    .option('--stdout', 'print the secret value even when stdout is an interactive terminal', false)
    .option('--api-key <key>', 'overrides VAULT_API_KEY')
    .option('--url <url>', 'overrides VAULT_URL')
    .option('--project-id <id>', 'overrides VAULT_PROJECT_ID')
    .action(
      async (
        name: string,
        options: { stdout: boolean; apiKey?: string; url?: string; projectId?: string }
      ) => {
        try {
          const config = resolveConfig(
            { apiKey: options.apiKey, url: options.url, projectId: options.projectId },
            runtime.env
          )
          const exitCode = await runGet({ name, stdout: options.stdout }, config, runtime.streams, {
            createVaultAgent: runtime.createVaultAgent,
          })
          runtime.setExitCode(exitCode)
        } catch (error) {
          if (error instanceof CliUsageError) {
            runtime.streams.stderr.write(`${error.message}\n`)
            runtime.setExitCode(1)
            return
          }
          throw error
        }
      }
    )

  program
    .command('login')
    .description(
      'Authenticate as a human user (email + password, plus TOTP if enrolled). WebAuthn-only ' +
        'accounts fail closed — see Epic 46 for CLI WebAuthn support.'
    )
    .option('--url <url>', 'overrides VAULT_URL')
    .action(async (options: { url?: string }) => {
      try {
        const config = resolveLoginConfig({ url: options.url }, runtime.env)
        const exitCode = await runLogin(config, runtime.streams, {
          fetchFn: runtime.fetchFn,
          prompt: runtime.prompt,
          env: runtime.env,
        })
        runtime.setExitCode(exitCode)
      } catch (error) {
        if (error instanceof CliUsageError) {
          runtime.streams.stderr.write(`${error.message}\n`)
          runtime.setExitCode(EXIT_CODES.usageError)
          return
        }
        throw error
      }
    })

  program
    .command('logout')
    .description('Remove the locally stored session (AC-6).')
    .action(async () => {
      const exitCode = await runLogout(runtime.streams, {
        fetchFn: runtime.fetchFn,
        env: runtime.env,
      })
      runtime.setExitCode(exitCode)
    })

  return program
}

/** The real entry point (see bin.ts) — wires the actual Node process streams/env and the real
 * `@project-vault/agent`. Kept separate from `buildProgram` so every test above can inject fakes
 * for all of it instead of touching the real process. */
export async function runCli(argv: string[]): Promise<void> {
  const streams: GetStreams = {
    stdout: process.stdout as unknown as WritableLike,
    stderr: process.stderr as unknown as WritableLike,
    isTTY: Boolean(process.stdout.isTTY),
  }
  const program = buildProgram({
    streams,
    env: process.env,
    createVaultAgent: realCreateVaultAgent,
    setExitCode: (code) => {
      process.exitCode = code
    },
    prompt: createRealPrompt(),
    fetchFn: fetch,
  })

  try {
    await program.parseAsync(argv)
  } catch (error) {
    // commander's exitOverride() throws a CommanderError instead of calling process.exit() for
    // things like --help/--version/a parse failure — those already wrote their own output via
    // configureOutput() above, so this just maps them to a non-zero exit rather than crashing.
    const exitCode = (error as { exitCode?: number }).exitCode
    process.exitCode = typeof exitCode === 'number' ? exitCode : 1
  }
}
