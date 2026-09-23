import { spawn as realSpawn } from 'node:child_process'
import { Command } from 'commander'
import {
  createVaultAgent as realCreateVaultAgent,
  type VaultAgent,
  type VaultAgentConfig,
} from '@project-vault/agent'
import { CliUsageError, EXIT_CODES } from './exit-codes.js'
import { resolveConfig, resolveLoginConfig } from './config.js'
import { runGet, type GetStreams, type WritableLike } from './get-command.js'
import type { ChildProcessLike, ParentProcessLike, SpawnFn } from './inject-and-run.js'
import { runLogin } from './login-command.js'
import { runLogout } from './logout-command.js'
import { createRealPrompt, type PromptFn } from './prompt.js'
import { runRun } from './run-command.js'

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
  /** Story 43.3 — the seam `run-command.ts`/`inject-and-run.ts` need to spawn and manage the
   * child process. */
  spawn: SpawnFn
  parentProcess: ParentProcessLike
}

const PACKAGE_VERSION = '0.0.1'

// Shared machine-user-key flag definitions, reused by `get` and `run` (both stay on the
// VAULT_API_KEY path — see config.ts's Dev Notes decision #2) — avoids duplicating the same
// flag/description literals across command definitions.
const API_KEY_FLAG = '--api-key <key>'
const API_KEY_DESCRIPTION = 'overrides VAULT_API_KEY'
const URL_FLAG = '--url <url>'
const URL_DESCRIPTION = 'overrides VAULT_URL'
const PROJECT_ID_FLAG = '--project-id <id>'
const PROJECT_ID_DESCRIPTION = 'overrides VAULT_PROJECT_ID'

function addMachineUserConfigFlags(command: Command): Command {
  return command
    .option(API_KEY_FLAG, API_KEY_DESCRIPTION)
    .option(URL_FLAG, URL_DESCRIPTION)
    .option(PROJECT_ID_FLAG, PROJECT_ID_DESCRIPTION)
}

/**
 * Shared action-wrapper for every subcommand: runs `action`, reports the number it resolves with
 * via `runtime.setExitCode()`, and turns a `CliUsageError` thrown anywhere inside it (typically
 * from `resolveConfig()`/`resolveLoginConfig()`) into a clean usage-error message on stderr —
 * exactly `get`/`login`/`run`'s previously-duplicated try/catch, consolidated into one place.
 */
async function runCommandAction(runtime: CliRuntime, action: () => Promise<number>): Promise<void> {
  try {
    const exitCode = await action()
    runtime.setExitCode(exitCode)
  } catch (error) {
    if (error instanceof CliUsageError) {
      runtime.streams.stderr.write(`${error.message}\n`)
      runtime.setExitCode(EXIT_CODES.usageError)
      return
    }
    throw error
  }
}

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

  // Story 43.3 Dev Notes decision #4 — verified directly against the installed commander@^14:
  // its own built-in `--` handling correctly treats everything after a literal `--` token as the
  // `run` subcommand's `<command...>` variadic argument, without attempting to parse the user's
  // own flags (e.g. `ls --help` after `--` is passed through untouched) — no manual
  // `process.argv`-split fallback is needed for the passthrough itself.
  //
  // What commander's default parsing does NOT give a clean error for is the two edge cases below
  // (a missing `--` entirely, and an empty command after it) — a `preSubcommand` hook runs BEFORE
  // the subcommand's own option/argument parsing, so it can inspect the raw args and produce
  // `pvault run`'s own clear usage error instead of commander's confusing default (e.g.
  // "unknown option '-la'" when the user forgot `--` before their own command's flags).
  program.hook('preSubcommand', (thisCommand, subcommand) => {
    if (subcommand.name() !== 'run') return
    const rawArgs = (thisCommand as unknown as { rawArgs: string[] }).rawArgs
    const runIndex = rawArgs.indexOf('run')
    const afterRun = runIndex === -1 ? [] : rawArgs.slice(runIndex + 1)
    const separatorIndex = afterRun.indexOf('--')
    if (separatorIndex === -1) {
      thisCommand.error(
        'pvault run: missing "--" separator before the command to run. Usage: pvault run --secret NAME -- <command> [args...]',
        { exitCode: EXIT_CODES.usageError }
      )
    }
    if (afterRun.slice(separatorIndex + 1).length === 0) {
      thisCommand.error('pvault run: no command given after "--".', {
        exitCode: EXIT_CODES.usageError,
      })
    }
  })

  addMachineUserConfigFlags(
    program
      .command('get')
      .description(
        'Fetch a single secret by name and write its value to stdout (AC-3: opt-in to print).'
      )
      .argument('<name>', 'the credential name to fetch')
      .option(
        '--stdout',
        'print the secret value even when stdout is an interactive terminal',
        false
      )
  ).action(
    async (
      name: string,
      options: { stdout: boolean; apiKey?: string; url?: string; projectId?: string }
    ) => {
      await runCommandAction(runtime, async () => {
        const config = resolveConfig(
          { apiKey: options.apiKey, url: options.url, projectId: options.projectId },
          runtime.env
        )
        return runGet({ name, stdout: options.stdout }, config, runtime.streams, {
          createVaultAgent: runtime.createVaultAgent,
        })
      })
    }
  )

  program
    .command('login')
    .description(
      'Authenticate as a human user (email + password, plus TOTP if enrolled). WebAuthn-only ' +
        'accounts fail closed — see Epic 46 for CLI WebAuthn support.'
    )
    .option(URL_FLAG, URL_DESCRIPTION)
    .action(async (options: { url?: string }) => {
      await runCommandAction(runtime, async () => {
        const config = resolveLoginConfig({ url: options.url }, runtime.env)
        return runLogin(config, runtime.streams, {
          fetchFn: runtime.fetchFn,
          prompt: runtime.prompt,
          env: runtime.env,
        })
      })
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

  program
    .command('run')
    .description(
      'Fetch one or more secrets and spawn a command with them injected into its environment ' +
        '(UX-DR16 — the documented default injection path). Pass --secrets-fd to deliver them ' +
        'over file descriptor 3 instead of the environment (Story 43.4).'
    )
    .option(
      '-s, --secret <name>',
      'a credential to inject, as NAME or NAME=ENV_VAR (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    // Story 43.4 AC-4 — Story 43.3's `--allow-unhardened-injection` opt-in was removed, not
    // aliased: commander now rejects it as an unknown option (loud, intended).
    .option(
      '--secrets-fd',
      'deliver the secrets as one JSON object on file descriptor 3 (PVAULT_SECRETS_FD=3) instead ' +
        'of as environment variables, keeping them out of the child process environment',
      false
    )
    .option(API_KEY_FLAG, API_KEY_DESCRIPTION)
    .option(URL_FLAG, URL_DESCRIPTION)
    .option(PROJECT_ID_FLAG, PROJECT_ID_DESCRIPTION)
    .argument('<command...>', 'the command (and its own arguments) to run, after a literal "--"')
    .action(
      async (
        command: string[],
        options: {
          secret: string[]
          secretsFd: boolean
          apiKey?: string
          url?: string
          projectId?: string
        }
      ) => {
        await runCommandAction(runtime, async () => {
          const config = resolveConfig(
            { apiKey: options.apiKey, url: options.url, projectId: options.projectId },
            runtime.env
          )
          const [runCommand, ...runCommandArgs] = command
          return runRun(
            {
              secrets: options.secret,
              command: runCommand ?? '',
              commandArgs: runCommandArgs,
              secretsFd: options.secretsFd,
            },
            config,
            runtime.streams,
            {
              createVaultAgent: runtime.createVaultAgent,
              spawn: runtime.spawn,
              parentProcess: runtime.parentProcess,
              env: runtime.env as NodeJS.ProcessEnv,
            }
          )
        })
      }
    )

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
    spawn: ((command, args, options) =>
      realSpawn(command, args, options) as unknown as ChildProcessLike) satisfies SpawnFn,
    parentProcess: process as unknown as ParentProcessLike,
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
