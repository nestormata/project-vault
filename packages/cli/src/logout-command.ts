import { sanitizeForTerminal } from './sanitize.js'
import { deleteSession, readSession, type EnvLike } from './session-store.js'

export type WritableLike = { write: (chunk: string) => void }
export type LogoutStreams = { stdout: WritableLike; stderr: WritableLike }

export type LogoutDeps = {
  fetchFn: typeof fetch
  env: EnvLike
}

/**
 * AC-6 — deletes the local session file unconditionally, and best-effort invalidates the refresh
 * token server-side first when a readable session exists (mirrors the web app's own logout,
 * preventing a deleted-locally-but-still-valid-server-side token from being usable if it somehow
 * leaked before deletion). The server call failing (offline, network error, already-invalid
 * token) never blocks the local deletion or turns `pvault logout` into a failure — logging out
 * while offline must still succeed at its primary local job.
 */
export async function runLogout(streams: LogoutStreams, deps: LogoutDeps): Promise<number> {
  const read = readSession(deps.env)
  if (read.status === 'ok') {
    try {
      await deps.fetchFn(`${read.session.baseUrl}/api/v1/auth/cli/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: read.session.refreshToken }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      streams.stderr.write(
        `warning: could not reach the server to invalidate the session remotely: ${sanitizeForTerminal(message)}\n`
      )
    }
  }

  const result = deleteSession(deps.env)
  streams.stdout.write(result.deleted ? 'Logged out.\n' : 'Not logged in.\n')
  return 0
}
