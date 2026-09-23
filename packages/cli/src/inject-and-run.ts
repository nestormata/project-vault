/**
 * Story 43.3 AC-6 — the injection primitive as a seam consumable by a non-CLI caller (the Epic 50
 * `FR177`/`inject_env` dependency named in this story's Origin section). This module has **zero**
 * imports of `commander`, `Command`, `CliRuntime`, or `process.argv` parsing anywhere in it — a
 * future non-CLI caller (once Epic 50 unblocks) can import `injectAndRun` directly, exactly as
 * `packages/cli/src/inject-and-run.non-cli-caller.test.ts` proves.
 *
 * `run-command.ts` is the thin CLI adapter: it parses `pvault run`'s flags into `InjectEntry[]`,
 * calls `injectAndRun()`, and maps the result to `CliRuntime.setExitCode()`.
 */
import { VaultAgentError } from '@project-vault/agent'
import { messageForAgentError } from './agent-error-messages.js'
import { withFetchProvenanceTracking } from './cache-provenance.js'
import { EXIT_CODES, exitCodeForAgentErrorCode } from './exit-codes.js'
import { isReservedEnvVarName } from './reserved-env-vars.js'
import { sanitizeForTerminal } from './sanitize.js'

export type InjectEntry = {
  /** The credential name to fetch from the vault. */
  credentialName: string
  /** The environment variable name to inject the fetched value as, in the child's environment. */
  envVarName: string
}

export type ChildProcessLike = {
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'inherit' }
) => ChildProcessLike

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
  getSecret: (name: string) => Promise<string>
  spawn: SpawnFn
  parentProcess: ParentProcessLike
  /** The environment the child inherits, layered with the injected vars on top — defaults to
   * `{}` when omitted (a real CLI caller always passes the real `process.env`). */
  baseEnv?: NodeJS.ProcessEnv
  /** Per-secret provenance/warning sink (Dev Notes decision #7). Optional — a non-CLI caller that
   * doesn't care about stderr-style diagnostics can simply omit it. */
  writeStderr?: (chunk: string) => void
}

export type InjectAndRunResult =
  | { ok: true; exitCode: number; terminatedBySignal?: NodeJS.Signals }
  | { ok: false; exitCode: number; error: string }

function noop(): void {
  // Default writeStderr when the caller doesn't supply one.
}

/**
 * Fail-closed, all-or-nothing sequential fetch (Dev Notes decision #3). Every requested secret is
 * fetched, in order, before `spawn()` is ever called. The first failure aborts immediately —
 * remaining secrets are never fetched, and the error returned is built ONLY from the failing
 * entry's own error, never from the partially-built map of already-fetched values (Security Audit
 * Personas finding, 2026-09-22 — a value already fetched but never used must never leak into the
 * abort-path error output).
 */
async function fetchAllOrNothing(
  entries: InjectEntry[],
  deps: Pick<InjectAndRunDeps, 'getSecret' | 'writeStderr'>
): Promise<
  { ok: true; injected: Record<string, string> } | { ok: false; exitCode: number; error: string }
> {
  const writeStderr = deps.writeStderr ?? noop
  const injected: Record<string, string> = {}

  for (const entry of entries) {
    const safeName = sanitizeForTerminal(entry.credentialName)
    try {
      // Dev Notes decision #7 — `run` participates in the same offline-cache fallback `get` does,
      // with its own mandatory per-secret provenance warning (never a silent, possibly-stale
      // injection).
      const { result: value, servedAfterNetworkFailure } = await withFetchProvenanceTracking(() =>
        deps.getSecret(entry.credentialName)
      )
      if (servedAfterNetworkFailure) {
        writeStderr(
          `warning: '${safeName}' served from offline cache (vault unreachable), value may be stale\n`
        )
      }
      injected[entry.envVarName] = value
    } catch (error) {
      // Only this entry's own failure is ever used to build the abort message — `injected` (which
      // may hold earlier, already-fetched values) is never serialized into it.
      if (error instanceof VaultAgentError) {
        return {
          ok: false,
          exitCode: exitCodeForAgentErrorCode(error.code),
          error: messageForAgentError(error, safeName),
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        exitCode: EXIT_CODES.unexpected,
        error: `Unexpected error fetching '${safeName}': ${sanitizeForTerminal(message)}`,
      }
    }
  }

  return { ok: true, injected }
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
  // AC-1 — reserved/dangerous env var names are refused before any network call, regardless of
  // caller (CLI or a future non-CLI Epic 50 broker) — this is an entry-level invariant, not a
  // CLI-argument-parsing concern.
  for (const entry of entries) {
    if (isReservedEnvVarName(entry.envVarName)) {
      return {
        ok: false,
        exitCode: EXIT_CODES.usageError,
        error: `Refusing to inject into reserved/dangerous environment variable '${entry.envVarName}' — this could hijack the child process's dynamic linker, shell, or interpreter.`,
      }
    }
  }

  // AC-1 edge case — duplicate target env var (whether by explicit rename collision or the same
  // credential requested twice) is a usage error caught before any network call.
  const seenTargets = new Set<string>()
  for (const entry of entries) {
    const key = entry.envVarName.toUpperCase()
    if (seenTargets.has(key)) {
      return {
        ok: false,
        exitCode: EXIT_CODES.usageError,
        error: `Duplicate environment variable target: ${entry.envVarName}`,
      }
    }
    seenTargets.add(key)
  }

  const fetched = await fetchAllOrNothing(entries, deps)
  if (!fetched.ok) {
    return { ok: false, exitCode: fetched.exitCode, error: fetched.error }
  }

  const childEnv: NodeJS.ProcessEnv = { ...(deps.baseEnv ?? {}), ...fetched.injected }

  return new Promise<InjectAndRunResult>((resolve) => {
    const child = deps.spawn(command, args, { env: childEnv, stdio: 'inherit' })

    // AC-4 edge case — forward a parent-received SIGINT to the running child, so the child gets a
    // chance to clean up rather than being orphaned. Removed once the child's own 'exit' handler
    // fires, so no dangling listener remains after the child is gone.
    const forwardSigint = (): void => {
      child.kill('SIGINT')
    }
    deps.parentProcess.on('SIGINT', forwardSigint)

    child.on('exit', (code, signal) => {
      deps.parentProcess.removeListener('SIGINT', forwardSigint)

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
