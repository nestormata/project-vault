// M4: a `$lib/server/*` module replacement that wraps PV's original. It keeps PV's own redirect for
// an anonymous request (the original runs first) and only decorates the user it returns.
import type { AuthUser } from '$lib/api/auth.js'
import { requireUser as original } from 'pv-original:$lib/server/require-user.ts'

export function requireUser(locals: { user?: AuthUser | null }): AuthUser {
  const user = original(locals)
  return { ...user, orgName: `${user.orgName} (mock-ui-pack-m4)` }
}
