import type { AuthUser } from '$lib/api/auth.js'
import { requireUser as original } from 'pv-original:$lib/server/require-user.ts'

export function requireUser(locals: { user?: AuthUser | null }): AuthUser {
  return original(locals)
}
