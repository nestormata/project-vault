/**
 * Story 43.3 AC-6 — the injection primitive as a seam consumable by a non-CLI caller (the Epic 50
 * `FR177`/`inject_env` dependency named in this story's Origin section). This module has **zero**
 * imports of `commander`, `Command`, `CliRuntime`, or `process.argv` parsing anywhere in it — a
 * future non-CLI caller (once Epic 50 unblocks) can import `injectAndRun` directly, exactly as
 * `packages/cli/src/inject-and-run.non-cli-caller.test.ts` proves.
 *
 * `run-command.ts` is the thin CLI adapter: it parses `pvault run`'s flags into `InjectEntry[]`,
 * calls `injectAndRun()`, and maps the result to `CliRuntime.setExitCode()`.
 *
 * Story 43.4 (FR158a, and Epic 50's FR179 "inherits this protection from the shared seam") — every
 * secondary-disclosure hardening lives HERE, not in the CLI adapter, so a future broker calling
 * `injectAndRun()` gets all of it for free: the `--secrets-fd` FD-3 pipe delivery, the stripping of
 * pvault's own `VAULT_API_KEY` from the child env, the audit invocation context sent on every
 * fetch, and `hardenProcessDiagnostics()`.
 *
 * Code-review guidance (Story 43.4 Dev Notes decision #7): no error path in this module may
 * serialize a fetched value, the `injected`/child-env map, the FD JSON payload, or the parent's
 * environment into a message — e.g. a debugging `console.error(childEnv)` or `JSON.stringify(deps)`
 * on an error path would violate AC-1 even though it has nothing to do with the child's own crash
 * output.
 */
import type { SecretRequestContext } from '@project-vault/agent'
import { EXIT_CODES } from './exit-codes.js'
import { checkEntryTargets, fetchAllOrNothing, type InjectEntry } from './fetch-secrets.js'
import { sanitizeForTerminal } from './sanitize.js'

// Story 43.5 A2 — `InjectEntry` now lives in `fetch-secrets.ts`; re-exported so existing imports
// keep compiling unchanged.
export type { InjectEntry }

/** The write end of the `--secrets-fd` pipe (Node's real `child.stdio[3]` is a `Writable`). */
export type SecretsPipeLike = {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  end(chunk: string): unknown
  /** Releases the handle once the child has exited (optional so minimal fakes still type-check). */
  destroy?(): unknown
}

export type ChildProcessLike = {
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
  /** Only read in `delivery: 'fd'` mode; a spawn that failed may leave the slot `null`. */
  stdio?: ReadonlyArray<SecretsPipeLike | object | null | undefined>
}

/** Story 43.4 AC-2 — FD 3 is the first slot after stdin/stdout/stderr. */
export const SECRETS_FD = 3
/** The non-secret marker telling the child which FD carries the JSON payload (like systemd's
 * `LISTEN_FDS`). */
export const SECRETS_FD_ENV_VAR = 'PVAULT_SECRETS_FD'
export type SpawnStdio = 'inherit' | ['inherit', 'inherit', 'inherit', 'pipe']

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: SpawnStdio }
) => ChildProcessLike

/** `env` (default): requested secrets become child env vars. `fd`: they are written as one JSON
 * object to an anonymous pipe on FD 3 and never appear in the child's environment. */
export type SecretsDelivery = 'env' | 'fd'

/**
 * Story 43.4 AC-1 / Dev Notes decision #5 — pvault's OWN credential, stripped from the env the
 * child inherits in both delivery modes. Without this, `VAULT_API_KEY=… pvault run --secret X --
 * app` would hand the child a key able to fetch every credential the machine user can reach — a
 * secondary-disclosure path strictly worse than the one this story closes. Non-secret config
 * (`VAULT_URL`, `VAULT_PROJECT_ID`) is left in place. An explicit `--secret VAULT_API_KEY` still
 * injects: the strip applies to the inherited base env only.
 */
export const CALLER_CREDENTIAL_ENV_VARS = ['VAULT_API_KEY'] as const
const CALLER_CREDENTIAL_ENV_VAR_SET: ReadonlySet<string> = new Set(CALLER_CREDENTIAL_ENV_VARS)

type DiagnosticReportSettings = {
  reportOnFatalError: boolean
  reportOnSignal: boolean
  reportOnUncaughtException: boolean
}

/**
 * Story 43.4 AC-1 — a Node diagnostic report (`--report-on-fatalerror`,
 * `--report-uncaught-exception`, `--report-on-signal`, settable through `NODE_OPTIONS`) writes a
 * JSON file containing pvault's full environment and a JS stack. These flags are writable at
 * runtime on Node >= 20, so turn all three off. Lives in the seam module (not `bin.ts`) so a
 * future Epic 50 broker process can call the same helper.
 *
 * NOT mitigable from Node (documented as residual risk in the README instead): heap snapshots
 * (`--heapsnapshot-signal`, `--heapsnapshot-near-heap-limit`) and OS core dumps of pvault itself.
 */
export function hardenProcessDiagnostics(proc: { report?: DiagnosticReportSettings }): void {
  if (!proc.report) return
  proc.report.reportOnFatalError = false
  proc.report.reportOnSignal = false
  proc.report.reportOnUncaughtException = false
}

/**
 * Story 43.4 AC-3 — the directly spawned binary's basename, split on both `/` and `\` (so a
 * Windows-style `C:\tools\psql.exe` gives `psql.exe` on any host). Never argv: argv routinely
 * carries other credentials (`mysql -p…`, connection URLs) that must not become audit-log content.
 * A wrapper (`env X=1 psql`, `sh -c …`) records the wrapper — accepted and documented.
 */
export function commandBasename(command: string): string {
  const segments = command.split(/[/\\]/)
  return segments.at(-1) ?? ''
}

/** The subset of Node's global `process` this module needs for signal handling — injected rather
 * than read from the real global, so the whole SIGINT-forwarding/signal-re-raise behavior stays
 * unit-testable without ever touching the real test-runner process. `run-command.ts` wires the
 * real `process` object here for actual CLI use. */
export type ParentProcessLike = {
  pid: number
  platform: NodeJS.Platform
  on(event: 'SIGINT', listener: () => void): void
  removeListener(event: 'SIGINT', listener: () => void): void
  kill(pid: number, signal: NodeJS.Signals): void
}

export type InjectAndRunDeps = {
  /** Called with the audit invocation context computed by the seam (Story 43.4 AC-3/AC-5). */
  getSecret: (name: string, context?: SecretRequestContext) => Promise<string>
  spawn: SpawnFn
  parentProcess: ParentProcessLike
  /** The environment the child inherits, layered with the injected vars on top — defaults to
   * `{}` when omitted (a real CLI caller always passes the real `process.env`). */
  baseEnv?: NodeJS.ProcessEnv
  /** Per-secret provenance/warning sink (Dev Notes decision #7). Optional — a non-CLI caller that
   * doesn't care about stderr-style diagnostics can simply omit it. */
  writeStderr?: (chunk: string) => void
  /** Story 43.4 AC-2 — defaults to `'env'`. */
  delivery?: SecretsDelivery
}

export type InjectAndRunResult =
  | { ok: true; exitCode: number; terminatedBySignal?: NodeJS.Signals }
  | { ok: false; exitCode: number; error: string }

function noop(): void {
  // Default writeStderr when the caller doesn't supply one.
}

function withoutCallerCredentials(baseEnv: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(baseEnv ?? {}).filter(
      // Case-insensitive, since Windows environment names are.
      ([name]) => !CALLER_CREDENTIAL_ENV_VAR_SET.has(name.toUpperCase())
    )
  )
}

/** "The reader went away" — not a pvault failure; the child's own exit code is what matters.
 * Node's `'pipe'` stdio is a socketpair on POSIX, so a child exiting without draining FD 3 shows
 * up as ECONNRESET (verified in inject-and-run.e2e.test.ts), not only EPIPE. */
const READER_GONE_ERROR_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
])

/**
 * Story 43.4 AC-2 — hands the JSON payload to the pipe's write end and returns immediately. It
 * never awaits the write: a payload larger than the OS pipe buffer (64 KiB on Linux) that the
 * child never reads would otherwise hang pvault forever — the caller settles on the child's
 * 'exit' as always. Errors are reported from `error.code` only, never from the payload.
 */
function deliverOverSecretsFd(
  child: ChildProcessLike,
  payload: string,
  writeStderr: (chunk: string) => void
): () => void {
  const pipe = child.stdio?.at(SECRETS_FD) as SecretsPipeLike | null | undefined
  // A spawn that failed (ENOENT) may leave the slot null — nothing to write into.
  if (!pipe) return noop
  // Without this listener, the child exiting without reading FD 3 (EPIPE) would surface as an
  // UNHANDLED stream error, crashing pvault with a stack trace and losing the child's exit code.
  pipe.on('error', (error) => {
    if (READER_GONE_ERROR_CODES.has(error.code ?? '')) return
    writeStderr(
      `warning: could not deliver secrets over FD ${SECRETS_FD} (${sanitizeForTerminal(error.code ?? 'unknown error')})\n`
    )
  })
  pipe.end(payload)
  // Called once the child has exited (or failed to spawn). Node's 'pipe' stdio is a duplex socket
  // that stays referenced until the peer closes its end — so a grandchild the child backgrounded
  // (and which inherited FD 3) would otherwise keep pvault's event loop alive, hanging `pvault run`
  // long after the command it ran has exited. Destroying our end discards only bytes still queued
  // in user space (the "settle on exit, let the stream be destroyed" contract); bytes already in
  // the kernel buffer stay readable by whoever still holds FD 3.
  return () => {
    pipe.destroy?.()
  }
}

/** Builds the child's env for the chosen delivery mode, spawns, and (fd mode) writes the payload —
 * only ever after every secret was fetched and spawn() returned. */
function spawnWithSecrets(
  command: string,
  args: string[],
  injected: Record<string, string>,
  deps: InjectAndRunDeps
): { child: ChildProcessLike; releaseSecretsPipe: () => void } {
  const inheritedEnv = withoutCallerCredentials(deps.baseEnv)
  if (deps.delivery !== 'fd') {
    const child = deps.spawn(command, args, {
      env: { ...inheritedEnv, ...injected },
      stdio: 'inherit',
    })
    return { child, releaseSecretsPipe: noop }
  }
  const child = deps.spawn(command, args, {
    env: { ...inheritedEnv, [SECRETS_FD_ENV_VAR]: String(SECRETS_FD) },
    stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  })
  const releaseSecretsPipe = deliverOverSecretsFd(
    child,
    JSON.stringify(injected),
    deps.writeStderr ?? noop
  )
  return { child, releaseSecretsPipe }
}

/**
 * Resolves `entries` to fetched values (fail-closed, all-or-nothing) and spawns `command`
 * `args` with those values layered into the child's full environment (AC-1), then propagates the
 * child's exit code or terminating signal exactly (AC-4). Never rewrites `command`/`args` with a
 * fetched value (AC-2/AC-3) — the child's argv is exactly what the caller passed in.
 */
export async function injectAndRun(
  entries: InjectEntry[],
  command: string,
  args: string[],
  deps: InjectAndRunDeps
): Promise<InjectAndRunResult> {
  // AC-1 — reserved/dangerous env var names and duplicate targets are refused before any network
  // call, regardless of caller (CLI or a future non-CLI Epic 50 broker) — an entry-level
  // invariant, shared with `write-env-file.ts` via `fetch-secrets.ts` (Story 43.5 Task 3).
  const invalid = checkEntryTargets(entries, 'inject into')
  if (invalid) return invalid

  // Story 43.4 AC-3/AC-5 — the seam (never the CLI adapter) computes the audit context, so any
  // caller of injectAndRun() sends it on every fetch. The label is hard-coded to `run` for now; an
  // Epic 50 broker will want its own (e.g. `mcp`) via an optional override here plus a one-value
  // server allowlist extension — deliberately not added until a consumer exists (YAGNI).
  const targetCommand = commandBasename(command)
  const context: SecretRequestContext =
    targetCommand === '' ? { invocation: 'run' } : { invocation: 'run', targetCommand }

  const fetched = await fetchAllOrNothing(entries, context, deps)
  if (!fetched.ok) {
    return { ok: false, exitCode: fetched.exitCode, error: fetched.error }
  }

  return new Promise<InjectAndRunResult>((resolve) => {
    // The fetched values are handed off inside spawnWithSecrets() and are not captured by any of
    // the listener closures below, so nothing here keeps them reachable once spawning is done.
    let spawned: ReturnType<typeof spawnWithSecrets>
    try {
      spawned = spawnWithSecrets(command, args, fetched.injected, deps)
    } catch (error) {
      // Node's spawn() THROWS synchronously for some invalid input — notably
      // ERR_INVALID_ARG_VALUE for an env value containing a NUL byte, whose message quotes the
      // offending value verbatim. So the message is never used here: only the error code (AC-1).
      const code = (error as { code?: unknown } | null)?.code
      resolve({
        ok: false,
        exitCode: EXIT_CODES.unexpected,
        error: `Failed to run '${sanitizeForTerminal(command)}' (${typeof code === 'string' ? sanitizeForTerminal(code) : 'spawn failed'})`,
      })
      return
    }
    const { child, releaseSecretsPipe } = spawned

    // AC-4 edge case — forward a parent-received SIGINT to the running child, so the child gets a
    // chance to clean up rather than being orphaned. Removed once the child's own 'exit' handler
    // fires, so no dangling listener remains after the child is gone.
    const forwardSigint = (): void => {
      child.kill('SIGINT')
    }
    deps.parentProcess.on('SIGINT', forwardSigint)

    // Guard against the promise settling twice — Node's real spawn() can emit 'error' (e.g. the
    // target binary doesn't exist — ENOENT) without a corresponding 'exit' on some platforms, but
    // there is no cross-platform guarantee that 'exit' is skipped, so both handlers must be safe
    // to have fire.
    let settled = false
    const cleanup = (): void => {
      deps.parentProcess.removeListener('SIGINT', forwardSigint)
      releaseSecretsPipe()
    }

    // Without this handler, a spawn failure (most commonly a typo'd/missing target command) would
    // leave this promise pending forever — Node does not guarantee an 'exit' event fires when the
    // child process could never be launched at all — hanging `pvault run` indefinitely with no
    // exit code ever reported.
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ok: false,
        exitCode: EXIT_CODES.unexpected,
        error: `Failed to run '${sanitizeForTerminal(command)}': ${sanitizeForTerminal(error.message)}`,
      })
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()

      if (signal) {
        // AC-4 — "propagate the child's exit code exactly, including signal-terminated cases"
        // means the parent's own termination IS the same signal event (matching npm/cross-env
        // class tools), not a synthetic 128+N code. On POSIX this re-raise (via
        // deps.parentProcess.kill) terminates the real process itself before any exit code this
        // function resolves with could ever be observed by a real caller.
        //
        // Windows edge case (Dev Notes decision #5) — Node's signal model on Windows is limited
        // (no real signal re-raise), so this documents the Windows-fallback: a plain non-zero
        // exit code (`childSignalTerminated`) rather than attempting an unsupported re-raise.
        if (deps.parentProcess.platform === 'win32') {
          resolve({
            ok: true,
            exitCode: EXIT_CODES.childSignalTerminated,
            terminatedBySignal: signal,
          })
          return
        }
        deps.parentProcess.kill(deps.parentProcess.pid, signal)
        resolve({
          ok: true,
          exitCode: EXIT_CODES.childSignalTerminated,
          terminatedBySignal: signal,
        })
        return
      }

      resolve({ ok: true, exitCode: code ?? 1 })
    })
  })
}
