/**
 * Story 43.28 AC-1 (extends Story 66.4 AC-4): why a database call failed, derived ONLY from the
 * error's `code` (Postgres SQLSTATE or Node errno/TLS code) through a closed map, never from its
 * message, `detail`, `hint` or `routine` (driver text can carry role names, hosts or DSNs).
 * Shared by the `startup.failed` log line and the admin-pool identity check.
 */
export type DbErrorReason =
  | 'auth_failed'
  | 'database_missing'
  | 'permission_denied'
  | 'schema_missing'
  | 'tls_failed'
  | 'connection_failed'
  | 'unknown'

export type DbErrorCause = {
  /** An enumerated identifier (`^[A-Z0-9_]{1,64}$`), or `invalid` when the value was anything else. */
  code: string
  reason: DbErrorReason
  /** How many `.cause` links were followed to reach the code (0 = the thrown value itself). */
  depth: number
}

// drizzle-orm 0.45 wraps driver errors in a DrizzleQueryError whose own message carries the query
// text and parameters; the SQLSTATE lives on its `cause`. Follow a short, bounded cause chain.
export const MAX_CAUSE_DEPTH = 3

const REASON_BY_CODE: ReadonlyMap<string, DbErrorReason> = new Map([
  ['28P01', 'auth_failed'],
  ['28000', 'auth_failed'],
  ['3D000', 'database_missing'],
  ['42501', 'permission_denied'],
  ['42P01', 'schema_missing'],
  ['42703', 'schema_missing'],
  ['3F000', 'schema_missing'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_failed'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_failed'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_failed'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'],
  ['CERT_HAS_EXPIRED', 'tls_failed'],
  ['ECONNREFUSED', 'connection_failed'],
  ['ENOTFOUND', 'connection_failed'],
  ['EAI_AGAIN', 'connection_failed'],
  ['ETIMEDOUT', 'connection_failed'],
  ['CONNECT_TIMEOUT', 'connection_failed'],
  ['57P03', 'connection_failed'],
])

const TLS_CODE_PREFIX = 'ERR_SSL_'
const CODE_FORMAT = /^[A-Z0-9_]{1,64}$/
const INVALID_CODE = 'invalid'

/** Own data property only: a getter (or a proxy-backed accessor) never runs during logging. */
function ownProperty(value: unknown, key: 'code' | 'cause'): unknown {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function reasonFor(code: string): DbErrorReason {
  const listed = REASON_BY_CODE.get(code)
  if (listed) return listed
  return code.startsWith(TLS_CODE_PREFIX) ? 'tls_failed' : 'unknown'
}

export function findDbErrorCause(err: unknown): DbErrorCause | null {
  let current = err
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const code = ownProperty(current, 'code')
    if (typeof code === 'string') {
      if (!CODE_FORMAT.test(code)) return { code: INVALID_CODE, reason: 'unknown', depth }
      return { code, reason: reasonFor(code), depth }
    }
    current = ownProperty(current, 'cause')
  }
  return null
}
