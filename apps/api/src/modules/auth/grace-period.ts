import { env } from '../../config/env.js'

export const GRACE_PERIOD_DAYS = env.MFA_PRIVILEGED_ROLE_GRACE_DAYS

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export function setGracePeriodOnPrivilegedRole({
  role,
  mfaEnrolledAt,
  existingGracePeriodExpiresAt = null,
  now = new Date(),
  gracePeriodDays = GRACE_PERIOD_DAYS,
}: {
  role: OrgRole
  mfaEnrolledAt: Date | null
  existingGracePeriodExpiresAt?: Date | null
  now?: Date
  gracePeriodDays?: number
}): Date | null {
  if (role !== 'owner' && role !== 'admin') return null
  if (mfaEnrolledAt !== null) return null
  if (existingGracePeriodExpiresAt !== null) return existingGracePeriodExpiresAt
  if (gracePeriodDays === 0) return now
  return new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000)
}
