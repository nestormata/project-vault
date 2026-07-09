import type { AuthUser } from '$lib/api/auth.js'
import { requireUser } from './require-user.js'

type Locals = { user?: AuthUser | null }

export type PlatformOperatorGateResult = { allowed: true; user: AuthUser } | { allowed: false }

export function platformOperatorGate(locals: Locals): PlatformOperatorGateResult {
  const user = requireUser(locals)
  if (!user.isPlatformOperator) return { allowed: false }
  return { allowed: true, user }
}
