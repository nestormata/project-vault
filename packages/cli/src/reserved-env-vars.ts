/**
 * Story 43.3 Dev Notes decision #1 — CLI-local port (not a vendored import) of
 * `packages/vault-action/src/parse-secrets.ts`'s `RESERVED_ENV_VAR_NAMES` protection, minus the
 * two GitHub-Actions-specific entries (`GITHUB_TOKEN`, and the `GITHUB_`/`ACTIONS_` prefix rules)
 * that don't apply to a terminal context — a `pvault run --` target command has no reason to be
 * blocked from setting a `GITHUB_`-prefixed var, since it isn't running inside a GitHub Actions
 * runner.
 *
 * `packages/vault-action/src/parse-secrets.ts` is intentionally NOT imported directly here: it is
 * `packages/vault-action`-local, parses a `PROJECT/NAME as ENV_VAR` shape this CLI doesn't need,
 * and carries `@actions/core`-adjacent conventions. This module ports only the reserved-name set
 * and the identifier-validity regex.
 */

/** Case-insensitive reserved/dangerous env var names — refusing to inject into any of these keeps
 * a `pvault run --` target command from having its dynamic linker, shell, or interpreter flags
 * hijacked via an injected credential name. */
export const RESERVED_ENV_VAR_NAMES = new Set(
  [
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'HOME',
    'SHELL',
  ].map((name) => name.toUpperCase())
)

export function isReservedEnvVarName(name: string): boolean {
  return RESERVED_ENV_VAR_NAMES.has(name.toUpperCase())
}

/** AC-1 edge case — a credential name is only usable directly as an env var name (no `=ENV_VAR`
 * rename given) when it already matches this shape. Project Vault credential names are free-form
 * (spaces, hyphens, lowercase, etc. are all valid) and are not guaranteed to satisfy this. */
export const SAFE_ENV_VAR_REGEX = /^[A-Za-z_]\w*$/

export function isValidEnvVarIdentifier(name: string): boolean {
  return SAFE_ENV_VAR_REGEX.test(name)
}
