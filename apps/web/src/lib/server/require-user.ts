import { redirect } from '@sveltejs/kit'
import type { AuthUser } from '$lib/api/auth.js'

type LocalsWithUser = { user?: AuthUser | null }

export function requireUser(locals: LocalsWithUser): AuthUser {
  if (!locals.user) throw redirect(303, '/login')
  return locals.user
}
