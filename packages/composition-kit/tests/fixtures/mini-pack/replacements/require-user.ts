// Story 68.5 AC-12: a `$lib/server/*` module replacement (materialized under src/lib/server/_cm, so
// Kit's server-only guard still applies to it). It runs in PV's web server process with the same
// trust as the file it shadows (invariant 0).
import type { AuthUser } from '$lib/api/auth.js'
import { requireUser as original } from 'pv-original:$lib/server/require-user.ts'

export function requireUser(locals: { user?: AuthUser | null }): AuthUser {
  const user = original(locals)
  return { ...user, orgName: `${user.orgName} (acme-server)` }
}
