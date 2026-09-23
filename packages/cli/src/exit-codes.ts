/**
 * Dev Notes decision #4 — exit-code scheme for AC-5. Every `.code` string
 * `@project-vault/agent`'s `VaultAgentError` (and subclasses) can throw gets its own distinct
 * exit code, so a CI pipeline can branch on `$?` reliably (e.g. retry-worthy "vault unreachable"
 * family vs. non-retry-worthy "credential not found"). This table is also reproduced in
 * `packages/cli/README.md` for operators who don't want to read source to find it.
 *
 * 0                success
 * 1                usage error (bad args, missing config, blank name, non-UUID project id,
 *                  interactive-TTY refusal without --stdout) — nothing ever reached
 *                  packages/agent on this path
 * 2-12             one exit code per VaultAgentError `.code` value, see the table below
 * 13               unexpected/unclassified error (a bug, or a future packages/agent error code
 *                  this CLI doesn't know about yet)
 */
export const EXIT_CODES = {
  usageError: 1,
  tokenExchangeFailed: 2,
  credentialNotFound: 3,
  insufficientRole: 4,
  ambiguousCredentialName: 5,
  vaultRequestFailed: 6,
  multiFieldSecretUnsupported: 7,
  vaultUnreachable: 8,
  vaultUnreachableNonCacheable: 9,
  cacheExpired: 10,
  cacheDecryptionFailed: 11,
  cacheCorrupted: 12,
  unexpected: 13,
  // Story 43.2 (Dev Notes decision #4) — append-only, `pvault login`/`logout`/session-consuming
  // command failure modes. Never renumber the block above.
  notLoggedIn: 14,
  sessionExpired: 15,
  invalidTotp: 16,
  mfaTokenExpired: 17,
  webauthnOnlyUnsupported: 18,
  insecureSessionFilePermissions: 19,
  nativeLoginDisabled: 20,
  // Not one of Dev Notes decision #4's originally-named codes, but a plain "email/password was
  // wrong" outcome needs its own distinguishable code too (append-only, same discipline as the
  // rest of this table) — reusing `usageError` would misleadingly suggest a bad CLI invocation
  // rather than a rejected credential.
  invalidCredentials: 21,
  // Story 43.3 (Dev Notes decision #5) — append-only, `pvault run --` failure modes. Never
  // renumber the blocks above.
  /** Zero `--secret` flags passed (AC-1's edge case) — deliberately distinct from `usageError` so
   * a wrapper script can branch on "forgot the injection flags" specifically. */
  secretsRequired: 22,
  /** The AC-5 opt-in flag (`--allow-unhardened-injection`) was omitted. Deliberately not reusing
   * `usageError` — a CI pipeline or wrapper script may want to branch specifically on "the
   * security gate wasn't acknowledged" versus a generic bad invocation. */
  unhardenedInjectionNotAcknowledged: 23,
  /** Windows-only fallback (AC-4's Windows edge case): the parent cannot itself re-raise the
   * child's terminating signal, so it reports this code instead. On POSIX, where the real signal
   * re-raise succeeds, this code is never actually observed — the process dies via the signal
   * itself, not via `setExitCode()`. */
  childSignalTerminated: 24,
} as const

// A Map (rather than a plain object keyed by an external string) sidesteps prototype-pollution/
// object-injection concerns entirely for a dynamic lookup key, with no eslint suppression needed.
const CODE_TO_EXIT_CODE: ReadonlyMap<string, number> = new Map([
  ['token_exchange_failed', EXIT_CODES.tokenExchangeFailed],
  ['credential_not_found', EXIT_CODES.credentialNotFound],
  ['insufficient_role', EXIT_CODES.insufficientRole],
  ['ambiguous_credential_name', EXIT_CODES.ambiguousCredentialName],
  ['vault_request_failed', EXIT_CODES.vaultRequestFailed],
  ['multi_field_secret_unsupported', EXIT_CODES.multiFieldSecretUnsupported],
  ['vault_unreachable', EXIT_CODES.vaultUnreachable],
  ['vault_unreachable_non_cacheable', EXIT_CODES.vaultUnreachableNonCacheable],
  ['cache_expired', EXIT_CODES.cacheExpired],
  ['cache_decryption_failed', EXIT_CODES.cacheDecryptionFailed],
  ['cache_corrupted', EXIT_CODES.cacheCorrupted],
])

/** Falls back to `EXIT_CODES.unexpected` for any `.code` this table doesn't recognize (e.g. a
 * future packages/agent release adding a new error code this CLI hasn't been updated for yet) —
 * never silently reuses another code's meaning. */
export function exitCodeForAgentErrorCode(code: string): number {
  return CODE_TO_EXIT_CODE.get(code) ?? EXIT_CODES.unexpected
}

/** A CLI-local usage error (bad input, missing config) — always maps to `EXIT_CODES.usageError`
 * and is raised before any network call reaches packages/agent. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}
