/**
 * Story 43.3 — pure parser for `pvault run`'s repeatable `--secret NAME[=ENV_VAR]` flag into
 * `InjectEntry[]` (the shape `inject-and-run.ts`'s `injectAndRun()` consumes). This is CLI-input
 * parsing (turning a raw `--secret` string into a structured entry) and stays in `run-command.ts`'s
 * layer, not `inject-and-run.ts` — a non-CLI caller (Epic 50) would build `InjectEntry[]` directly
 * in code and has no `--secret`-flag string to parse. `injectAndRun()` itself still separately
 * enforces the entry-level invariants (reserved names, duplicate targets) that apply to any
 * caller, CLI or not — see its own AC-1 checks.
 *
 * Makes zero network calls and imports nothing from `commander` — every validation here runs
 * before any fetch is attempted, mirroring `packages/vault-action/src/parse-secrets.ts`'s
 * "validate everything first" discipline (Story 43.3 Dev Notes "Architecture & prior art").
 */
import type { InjectEntry } from './inject-and-run.js'
import { isValidEnvVarIdentifier } from './reserved-env-vars.js'

export type ParseRunSecretsSuccess = { ok: true; entries: InjectEntry[] }
export type ParseRunSecretsFailure = { ok: false; error: string }
export type ParseRunSecretsResult = ParseRunSecretsSuccess | ParseRunSecretsFailure

/**
 * Parses a single `--secret` flag value. Accepted shapes: `NAME` (credential name doubles as the
 * target env var — only when `NAME` is itself a valid identifier) or `NAME=ENV_VAR` (explicit
 * rename).
 */
function parseOne(raw: string): InjectEntry | ParseRunSecretsFailure {
  const eqIndex = raw.indexOf('=')

  if (eqIndex === -1) {
    // AC-1 edge case — a credential name with no valid env-var-identifier shape and no explicit
    // rename must be refused locally, before any network call, rather than silently attempting to
    // set an environment variable with an undefined/mangled name.
    if (!isValidEnvVarIdentifier(raw)) {
      return {
        ok: false,
        error: `--secret '${raw}': not a valid environment variable name. Supply an explicit rename: --secret "${raw}=ENV_VAR_NAME".`,
      }
    }
    return { credentialName: raw, envVarName: raw }
  }

  const credentialName = raw.slice(0, eqIndex)
  const envVarName = raw.slice(eqIndex + 1)

  // AC-1 edge case — malformed `--secret` value shape: an empty credential name or empty target
  // env var around `=` must both be rejected, rather than silently coercing to an empty string.
  if (credentialName.length === 0 || envVarName.length === 0) {
    return {
      ok: false,
      error: `--secret '${raw}': malformed — expected 'NAME=ENV_VAR', with both sides non-empty.`,
    }
  }

  if (!isValidEnvVarIdentifier(envVarName)) {
    return {
      ok: false,
      error: `--secret '${raw}': '${envVarName}' is not a valid environment variable name (must match ^[A-Za-z_][A-Za-z0-9_]*$).`,
    }
  }

  return { credentialName, envVarName }
}

export function parseRunSecrets(raw: string[]): ParseRunSecretsResult {
  const entries: InjectEntry[] = []
  for (const value of raw) {
    const parsed = parseOne(value)
    if ('ok' in parsed) return parsed
    entries.push(parsed)
  }
  return { ok: true, entries }
}
