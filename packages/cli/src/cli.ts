import { spawn as realSpawn } from 'node:child_process'
import { Command, CommanderError } from 'commander'
import {
  createVaultAgent as realCreateVaultAgent,
  type VaultAgent,
  type VaultAgentConfig,
} from '@project-vault/agent'
import { AGENT_BUILD_INFO } from '@project-vault/agent/build-info'
import { CLI_BUILD_INFO, formatVersionOutput, type BuildInfo } from './build-info.js'
import { CliUsageError, EXIT_CODES } from './exit-codes.js'
import { resolveConfig, resolveLoginConfig } from './config.js'
import { runGet, type GetStreams, type WritableLike } from './get-command.js'
import type { ChildProcessLike, ParentProcessLike, SpawnFn } from './inject-and-run.js'
import { runLogin } from './login-command.js'
import { runLogout } from './logout-command.js'
import { createRealPrompt, type PromptFn } from './prompt.js'
import { runRun } from './run-command.js'
import type { GitIgnoreStatus } from './git-ignore-check.js'
import { runWriteEnv } from './write-env-command.js'
import { runVersionCheck } from './version-check.js'
import { noVersionCheckWarning, parseNoVersionCheck } from './version-check-opt-out.js'
import { sessionDir } from './session-store.js'

// Dev Notes decision #6 — CLI argument-parsing/command framework: commander (already resolved
// elsewhere in this monorepo's lockfile), a real subcommand framework rather than hand-rolled
// `process.argv` parsing, chosen because this is the first story of a six-story epic whose later
// stories (`login`, `run -- <cmd>`, `.env` materialization, a startup version check) all add more
// multi-command, multi-flag surface. See packages/cli/README.md. (The startup version check is
// Story 43.6 — see version-check.ts and the `preAction` hook in buildProgram below.)

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
  /** Story 43.5 — base directory for `write-env`'s relative `--output`; defaults to
   * `process.cwd()`. */
  cwd?: string
  /** Story 43.5 AC-9 — the accidental-commit check seam; defaults to a real `git check-ignore`. */
  checkGitIgnored?: (dir: string, name: string) => Promise<GitIgnoreStatus>
  /** Story 43.6 AC-4 — build identity override for tests; defaults to the stamped modules. */
  buildInfo?: { cli: BuildInfo; agent: BuildInfo }
  /** Story 43.6 — the startup version check's seams. Inert by default: only `runCli()` (the real
   * entry) supplies it, so tests that build the program without it never make a check request,
   * even on a stamped tree. `cacheDir: null` → no cache (the check still runs). */
  versionCheck?: { fetchFn: typeof fetch; now: () => number; cacheDir: string | null }
}

/** Story 43.6 AC-6 — every subcommand is in exactly one of these sets (enforced by a test). */
export const VERSION_CHECKED_COMMANDS: ReadonlySet<string> = new Set([
  'get',
  'run',
  'write-env',
  'login',
])
/** `logout` only reduces exposure (revokes and deletes the stored session), so a withdrawn CLI can
 * always still run it. */
export const VERSION_CHECK_EXEMPT_COMMANDS: ReadonlySet<string> = new Set(['logout'])

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

/** The repeatable `-s/--secret NAME[=ENV_VAR]` flag, shared by `run` and `write-env` (Story 43.5)
 * so both commands accept exactly the same grammar. */
function addSecretFlag(command: Command, verb: string): Command {
  return command.option(
    '-s, --secret <name>',
    `a credential to ${verb}, as NAME or NAME=ENV_VAR (repeatable)`,
    (value: string, previous: string[]) => [...previous, value],
    []
  )
}

type MachineUserFlagValues = { apiKey?: string; url?: string; projectId?: string }

function resolveMachineUserConfig(runtime: CliRuntime, options: MachineUserFlagValues) {
  return resolveConfig(
    { apiKey: options.apiKey, url: options.url, projectId: options.projectId },
    runtime.env
  )
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

/**
 * Story 43.6 (decision D7) — the single wiring point of the version check: runs before a
 * version-checked command's own network activity and is awaited, so a withdrawn refusal always
 * precedes the first credential request, prompt, child spawn or file write.
 */
function versionCheckTarget(
  runtime: CliRuntime,
  actionCommand: Command
): { cliVersion: string; baseUrl: string } | null {
  if (!runtime.versionCheck || !VERSION_CHECKED_COMMANDS.has(actionCommand.name())) return null
  const cliVersion = (runtime.buildInfo?.cli ?? CLI_BUILD_INFO).version
  const flagUrl = actionCommand.opts<{ url?: string }>().url
  const baseUrl = flagUrl ?? runtime.env['VAULT_URL']
  if (cliVersion === 'dev' || !baseUrl) return null
  return { cliVersion, baseUrl }
}

async function versionCheckHook(runtime: CliRuntime, actionCommand: Command): Promise<void> {
  const target = versionCheckTarget(runtime, actionCommand)
  const check = runtime.versionCheck
  if (!target || !check) return

  const optOutRaw = runtime.env['PVAULT_NO_VERSION_CHECK']
  const optOut = parseNoVersionCheck(optOutRaw)
  if (optOut.invalid) runtime.streams.stderr.write(noVersionCheckWarning(optOutRaw ?? ''))

  const result = await runVersionCheck({
    ...target,
    fetchFn: check.fetchFn,
    now: check.now,
    cacheDir: check.cacheDir,
    writeStderr: (chunk) => runtime.streams.stderr.write(chunk),
    suppressNotices: optOut.suppress,
  })
  if (result.refuse) {
    runtime.setExitCode(result.exitCode)
    throw new CommanderError(result.exitCode, 'pvault.versionWithdrawn', 'pvault version withdrawn')
  }
}

export function buildProgram(runtime: CliRuntime): Command {
  const program = new Command()
  const versionOutput = formatVersionOutput(
    runtime.buildInfo?.cli ?? CLI_BUILD_INFO,
    runtime.buildInfo?.agent ?? AGENT_BUILD_INFO
  )
  // Story 43.6 AC-4 — the skew warning goes to stderr. Registered before `.version()` so it runs
  // before commander's own version listener, which writes stdout and exits.
  program.on('option:version', () => {
    if (versionOutput.stderr) runtime.streams.stderr.write(versionOutput.stderr)
  })
  program
    .name('pvault')
    .description(
      'Project Vault CLI — fetch and inject secrets from the terminal using a machine-user API key.'
    )
    .version(versionOutput.stdout.trimEnd(), '-V, --version')
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

  // Story 43.6 — runs after `preSubcommand` (so `pvault run` without `--` never reaches it).
  program.hook('preAction', (_thisCommand, actionCommand) =>
    versionCheckHook(runtime, actionCommand)
  )

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
        const config = resolveMachineUserConfig(runtime, options)
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

  addSecretFlag(
    program
      .command('run')
      .description(
        'Fetch one or more secrets and spawn a command with them injected into its environment ' +
          '(UX-DR16 — the documented default injection path). Pass --secrets-fd to deliver them ' +
          'over file descriptor 3 instead of the environment (Story 43.4).'
      ),
    'inject'
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
          const config = resolveMachineUserConfig(runtime, options)
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

  // Story 43.5 — `pvault write-env`. Dev Notes decision #8: positioned as the fallback to
  // `run --` (which never writes secrets to disk); deliberately no alias/shortcut. `--output` is
  // declared optional here and validated in `runWriteEnv()` so a missing value gets this command's
  // own usage error (exit 1) rather than commander's generic one.
  addMachineUserConfigFlags(
    addSecretFlag(
      program
        .command('write-env')
        .description(
          'Write named secrets to a local file for tooling that can only read from a file (prefer "pvault run --", which never writes secrets to disk).'
        ),
      'write'
    )
      .option('-o, --output <path>', 'the file to write (required; never defaults)')
      .option('--force', 'replace an existing file (never a directory, FIFO, or device)', false)
      .option('--format <format>', 'dotenv (Node --env-file) or shell (POSIX source)', 'dotenv')
  ).action(
    async (
      options: MachineUserFlagValues & {
        secret: string[]
        output?: string
        force: boolean
        format: string
      }
    ) => {
      await runCommandAction(runtime, async () => {
        const config = resolveMachineUserConfig(runtime, options)
        return runWriteEnv(
          {
            secrets: options.secret,
            output: options.output,
            force: options.force,
            format: options.format,
          },
          config,
          runtime.streams,
          {
            createVaultAgent: runtime.createVaultAgent,
            cwd: runtime.cwd ?? process.cwd(),
            checkGitIgnored: runtime.checkGitIgnored,
          }
        )
      })
    }
  )

  return program
}

/** Story 43.6 AC-8 — the cache lives next to the session file; with neither `XDG_CONFIG_HOME` nor
 * a home directory there is no cache (the check itself still runs). */
function versionCheckCacheDir(env: Record<string, string | undefined>): string | null {
  const hasBase = [env['XDG_CONFIG_HOME'], env['HOME'], env['USERPROFILE']].some(Boolean)
  return hasBase ? sessionDir(env) : null
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
    versionCheck: { fetchFn: fetch, now: Date.now, cacheDir: versionCheckCacheDir(process.env) },
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
