/**
 * Story 43.4 AC-3 — the optional, client-asserted invocation context a caller can attach to a
 * `getSecret()` fetch, so the server's audit entry for the reveal can record *why* the value was
 * fetched (`get` = printed, `run` = handed to a child process, `write-env` = persisted to a file) and which command it was handed to.
 *
 * The server treats both values as advisory, client-asserted data (it records them under
 * `clientInvocation`/`clientTargetCommand`), never as a verified fact about what ran.
 */
export type InvocationLabel = 'get' | 'run' | 'write-env'

export type SecretRequestContext = {
  invocation: InvocationLabel
  /** The basename of the directly spawned command (`run` only) — never full argv. */
  targetCommand?: string
}

export const INVOCATION_HEADER = 'x-vault-invocation'
export const TARGET_COMMAND_HEADER = 'x-vault-target-command'
/** Mirrors the server's `^[A-Za-z0-9%._+~-]{1,128}$` acceptance pattern. */
export const TARGET_COMMAND_HEADER_MAX_LENGTH = 128

// A future Epic 50 broker label (e.g. `mcp`) is a one-value extension here AND in the server's
// allowlist (machine-credential-schema.ts) — deliberately not added until a consumer exists.
const ALLOWED_INVOCATIONS: ReadonlySet<string> = new Set<InvocationLabel>([
  'get',
  'run',
  'write-env',
])

const REPLACEMENT_CHARACTER_ENCODED = '%EF%BF%BD'

/** encodeURIComponent() leaves `!'()*` unescaped; the server's pattern does not accept them. */
function encodeCodePoint(char: string): string {
  let encoded: string
  try {
    encoded = encodeURIComponent(char)
  } catch {
    // A lone UTF-16 surrogate makes encodeURIComponent throw URIError — substitute U+FFFD rather
    // than let an exception escape header construction.
    return REPLACEMENT_CHARACTER_ENCODED
  }
  return encoded.replaceAll(
    /[!'()*]/g,
    (c) => `%${Number(c.codePointAt(0)).toString(16).toUpperCase()}`
  )
}

/**
 * Percent-encodes `command` to a header-safe ASCII token and truncates it to at most
 * {@link TARGET_COMMAND_HEADER_MAX_LENGTH} encoded characters, cutting only on whole code points
 * (never mid-escape, which the server's `decodeURIComponent` would reject).
 *
 * Why this matters (Pre-mortem finding): `fetch()` throws a `TypeError` for a header value that is
 * not a valid ByteString, and a `TypeError` from `fetch` is exactly the agent's "network failure →
 * serve from offline cache" signal. An unencoded `データ.sh` would silently turn a live, audited
 * fetch into a stale, unaudited cache hit.
 */
export function encodeTargetCommand(command: string): string {
  let result = ''
  for (const char of command) {
    const piece = encodeCodePoint(char)
    if (result.length + piece.length > TARGET_COMMAND_HEADER_MAX_LENGTH) break
    result += piece
  }
  return result
}

/**
 * Builds the invocation-context headers for one credential-value request. Pure and non-throwing
 * by construction — it runs outside the `fetch()` error classification that decides whether to
 * fall back to the offline cache.
 */
export function buildInvocationContextHeaders(
  context: SecretRequestContext | undefined
): Record<string, string> {
  if (!context || !ALLOWED_INVOCATIONS.has(context.invocation)) return {}
  const encoded =
    typeof context.targetCommand === 'string' ? encodeTargetCommand(context.targetCommand) : ''
  return {
    [INVOCATION_HEADER]: context.invocation,
    ...(encoded === '' ? {} : { [TARGET_COMMAND_HEADER]: encoded }),
  }
}
