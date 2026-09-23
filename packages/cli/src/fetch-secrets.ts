/**
 * Story 43.5 Task 3 (Grounding finding G6) — the fail-closed, all-or-nothing secret fetch,
 * extracted verbatim from Story 43.3's `inject-and-run.ts` so `pvault run --` and
 * `pvault write-env` (and a future Epic 50 broker) share ONE implementation. Also owns the
 * `InjectEntry` type (Story 43.5 A2: `write-env-file.ts` must not import from its sibling seam
 * `inject-and-run.ts`, which re-exports the type for backward compatibility).
 *
 * Zero imports of `commander`/`cli.ts`/`CliRuntime`/`process.argv` — same structural rule as the
 * two seams that consume it.
 */
import { VaultAgentError, type SecretRequestContext } from '@project-vault/agent'
import { messageForAgentError } from './agent-error-messages.js'
import { withFetchProvenanceTracking } from './cache-provenance.js'
import { EXIT_CODES, exitCodeForAgentErrorCode } from './exit-codes.js'
import { isReservedEnvVarName } from './reserved-env-vars.js'
import { sanitizeForTerminal } from './sanitize.js'

export type InjectEntry = {
  /** The credential name to fetch from the vault. */
  credentialName: string
  /** The environment variable name the fetched value is delivered as. */
  envVarName: string
}

export type FetchSecretsDeps = {
  /** Called with the audit invocation context the calling seam supplies (Story 43.4 AC-3). */
  getSecret: (name: string, context?: SecretRequestContext) => Promise<string>
  /** Per-secret provenance/warning sink. Optional — a non-CLI caller may omit it. */
  writeStderr?: (chunk: string) => void
}

export type EntryFailure = { ok: false; exitCode: number; error: string }

export type FetchAllResult =
  | {
      ok: true
      injected: Record<string, string>
      /** How many values came from `packages/agent`'s offline cache (Story 43.5 success line). */
      servedFromCacheCount: number
    }
  | EntryFailure

function noop(): void {
  // Default writeStderr when the caller doesn't supply one.
}

/**
 * Entry-level invariants that apply to every caller (CLI or not), checked before any network
 * call: reserved/dangerous target names (Story 43.3 AC-1; for files too, Story 43.5 AC-6 / G3) and
 * case-insensitive duplicate targets. `action` completes the sentence "Refusing to <action>
 * reserved/dangerous environment variable …" (e.g. `inject into`, `write`). Returns `null` when
 * every entry is acceptable.
 */
export function checkEntryTargets(entries: InjectEntry[], action: string): EntryFailure | null {
  for (const entry of entries) {
    if (isReservedEnvVarName(entry.envVarName)) {
      return {
        ok: false,
        exitCode: EXIT_CODES.usageError,
        error: `Refusing to ${action} reserved/dangerous environment variable '${entry.envVarName}' — this could hijack the child process's dynamic linker, shell, or interpreter.`,
      }
    }
  }

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
  return null
}

/**
 * Fail-closed, all-or-nothing sequential fetch (Story 43.3 Dev Notes decision #3). Every requested
 * secret is fetched, in order, before the caller does anything with any of them. The first failure
 * aborts immediately — remaining secrets are never fetched, and the error returned is built ONLY
 * from the failing entry's own error, never from the partially-built map of already-fetched values
 * (Security Audit Personas finding, 2026-09-22 — a value already fetched but never used must never
 * leak into the abort-path error output).
 */
export async function fetchAllOrNothing(
  entries: InjectEntry[],
  context: SecretRequestContext,
  deps: FetchSecretsDeps
): Promise<FetchAllResult> {
  const writeStderr = deps.writeStderr ?? noop
  // Object.create(null) rather than `{}` — a target env var name of `__proto__` (a syntactically
  // valid, non-reserved identifier) would otherwise hit `Object.prototype`'s `__proto__` accessor
  // on plain-object bracket assignment, which silently no-ops for a non-object value instead of
  // setting an own property. That would make the requested secret vanish with no error — a
  // fail-open gap in code whose whole purpose is guaranteed delivery. A null-prototype object has
  // no such accessor, so the assignment below always sets a real own property, and a later
  // `{ ...injected }` spread (CopyDataProperties semantics, not [[Set]]) carries it through.
  const injected: Record<string, string> = Object.create(null) as Record<string, string>
  let servedFromCacheCount = 0

  for (const entry of entries) {
    const safeName = sanitizeForTerminal(entry.credentialName)
    try {
      // Story 43.3 Dev Notes decision #7 — participates in the same offline-cache fallback `get`
      // does, with a mandatory per-secret provenance warning (never a silent, possibly-stale value).
      // Story 43.4 decision #6 — a cache-served value makes no HTTP request, so the server writes no
      // audit entry for it: say so rather than refuse (accepted residual risk, see the README).
      const { result: value, servedAfterNetworkFailure } = await withFetchProvenanceTracking(() =>
        deps.getSecret(entry.credentialName, context)
      )
      if (servedAfterNetworkFailure) {
        servedFromCacheCount += 1
        writeStderr(
          `warning: '${safeName}' served from offline cache (vault unreachable), value may be stale and this fetch is not recorded in the vault audit log\n`
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

  return { ok: true, injected, servedFromCacheCount }
}
