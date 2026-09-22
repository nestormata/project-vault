import { EXIT_CODES } from './exit-codes.js'
import { readSession, writeSession, type EnvLike, type SessionData } from './session-store.js'

/**
 * AC-4/Dev Notes decision #2 — reusable by any future session-consuming command (none exists yet
 * in this story's own scope; see Dev Notes decision #2's explicit scope boundary — `pvault get`
 * still only consumes `VAULT_API_KEY`). `ensureFreshSession()` is the one seam that
 * decision/AC-7's browser-extension inheritor (Story 51.2) and any future CLI command should
 * call before using a stored session, so the silent-refresh/re-prompt logic is decided and
 * implemented exactly once.
 */
export type EnsureSessionResult =
  | { status: 'ok'; session: SessionData }
  | { status: 'not_logged_in' }
  | { status: 'insecure_permissions'; path: string }
  | { status: 'session_expired' }

export type RefreshDeps = {
  fetchFn: typeof fetch
  env: EnvLike
  /** Injectable clock, defaults to `Date.now` — lets tests exercise "about to expire" precisely. */
  now?: () => number
}

/** Refresh proactively once fewer than this many ms remain — avoids racing a request that starts
 * just before expiry and completes just after. */
const REFRESH_SKEW_MS = 30_000

type RefreshBearerData = { accessToken: string; refreshToken: string; expiresIn: number }

function isRefreshBearerData(value: unknown): value is RefreshBearerData {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['expiresIn'] === 'number'
  )
}

async function attemptRefresh(
  session: SessionData,
  deps: RefreshDeps
): Promise<SessionData | null> {
  let response: Response
  try {
    response = await deps.fetchFn(`${session.baseUrl}/api/v1/auth/cli/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })
  } catch {
    return null
  }
  if (response.status !== 200) return null

  let json: unknown
  try {
    json = await response.json()
  } catch {
    return null
  }
  const data = (json as { data?: unknown } | null)?.data
  if (!isRefreshBearerData(data)) return null

  const updated: SessionData = {
    ...session,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
  }
  writeSession(updated, deps.env)
  return updated
}

/**
 * AC-4 — returns the usable session (refreshing it silently first if the access token is expired
 * or about to be, per Dev Notes decision #2), or a distinguishable reason it could not. Never
 * throws for an expired/dead session — callers translate the result via
 * `messageForSessionFailure()` below.
 */
export async function ensureFreshSession(deps: RefreshDeps): Promise<EnsureSessionResult> {
  const read = readSession(deps.env)
  if (read.status === 'not_found') return { status: 'not_logged_in' }
  if (read.status === 'insecure_permissions') return read

  const now = deps.now ? deps.now() : Date.now()
  const expiresAtMs = Date.parse(read.session.accessExpiresAt)
  if (Number.isFinite(expiresAtMs) && expiresAtMs - now > REFRESH_SKEW_MS) {
    return { status: 'ok', session: read.session }
  }

  const refreshed = await attemptRefresh(read.session, deps)
  if (refreshed) return { status: 'ok', session: refreshed }

  // AC-4 concurrency edge case — a losing process in a refresh-token-rotation race must not
  // declare the session dead without first re-reading the file: another process may have already
  // written fresh tokens a moment earlier.
  const reread = readSession(deps.env)
  if (reread.status === 'ok') {
    const rereadExpiresAtMs = Date.parse(reread.session.accessExpiresAt)
    if (Number.isFinite(rereadExpiresAtMs) && rereadExpiresAtMs - now > 0) {
      return { status: 'ok', session: reread.session }
    }
  }

  return { status: 'session_expired' }
}

/** AC-4/AC-5 — the exact user-facing message + exit code for every non-`ok` outcome, so a raw
 * 401/"file missing" is never what reaches the terminal. */
export function messageForSessionFailure(result: Exclude<EnsureSessionResult, { status: 'ok' }>): {
  message: string
  exitCode: number
} {
  if (result.status === 'not_logged_in') {
    return {
      message: 'Not logged in. Run `pvault login` to sign in.\n',
      exitCode: EXIT_CODES.notLoggedIn,
    }
  }
  if (result.status === 'insecure_permissions') {
    return {
      message:
        `Refusing to use the session file at ${result.path} — its permissions are too open. ` +
        `Fix with \`chmod 600 ${result.path}\`, or run \`pvault login\` to regenerate it.\n`,
      exitCode: EXIT_CODES.insecureSessionFilePermissions,
    }
  }
  return {
    message: 'Your session has expired. Run `pvault login` to sign in again.\n',
    exitCode: EXIT_CODES.sessionExpired,
  }
}
