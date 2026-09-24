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
 * 14-28            later stories' append-only blocks (see each block's comment below)
 * 29               this pvault version has been withdrawn by the server (Story 43.6)
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
  /** RETIRED (Story 43.4 AC-4) — never returned since Story 43.4 removed Story 43.3's
   * `--allow-unhardened-injection` opt-in gate. Formerly: the opt-in flag was omitted. The slot is
   * kept and must NEVER be reused for another meaning — a script that branched on `23` during the
   * gated interval between 43.3 and 43.4 must not have it silently repurposed (same "keep the slot,
   * document why it's dormant" pattern as `childSignalTerminated` below). */
  unhardenedInjectionNotAcknowledged: 23,
  /** Windows-only fallback (AC-4's Windows edge case): the parent cannot itself re-raise the
   * child's terminating signal, so it reports this code instead. On POSIX, where the real signal
   * re-raise succeeds, this code is never actually observed — the process dies via the signal
   * itself, not via `setExitCode()`. */
  childSignalTerminated: 24,
  // Story 43.5 (Dev Notes decision #5) — append-only, `pvault write-env` failure modes. Never
  // renumber the blocks above.
  /** The `--output` target already exists (including a symlink, even a dangling one) and
   * `--force` was not passed — checked before any network call and again atomically at commit. */
  outputExists: 25,
  /** The `--output` path cannot be a secrets file: its parent directory is missing, it is a
   * directory, or it is a non-regular file (FIFO, socket, device) — refused even with `--force`. */
  outputPathInvalid: 26,
  /** A fetched value cannot be represented losslessly in the requested `--format` (or contains
   * NUL/CR in `dotenv`) — refused rather than silently corrupted; nothing is written. */
  valueNotRepresentable: 27,
  /** An unexpected filesystem error while writing (`EACCES`, `ENOSPC`, `EROFS`, …). */
  outputWriteFailed: 28,
  // Story 43.6 — append-only. Never renumber the blocks above; slot 23 stays retired.
  /** The server lists this exact `pvault` version as withdrawn (or did at the last successful
   * check while it is now unreachable). Refused before any credential request, prompt, child
   * spawn or file write. `pvault run` also propagates a child's own exit code, so a `29` from
   * `run` is this refusal only when no child was spawned (the stderr line says which). */
  cliVersionWithdrawn: 29,
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
