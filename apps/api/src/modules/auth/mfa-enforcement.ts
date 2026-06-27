import { and, eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, users } from '@project-vault/db/schema'

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

const MFA_REQUIRED_MESSAGE =
  'MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security.'

export type ComputedMfaStatus = {
  mfaEnrolled: boolean
  mfaStatus: {
    enrollmentRequired: boolean
    gracePeriodActive: boolean
    gracePeriodExpiresAt: string | null
    gracePeriodDaysRemaining: number | null
    bannerMessage: string | null
  }
}

export function isMfaEnforcementActive(
  orgRole: OrgRole,
  mfaEnrolledAt: Date | null,
  gracePeriodExpiresAt: Date | null,
  now = new Date()
): boolean {
  if (orgRole !== 'owner' && orgRole !== 'admin') return false
  if (mfaEnrolledAt !== null) return false
  if (gracePeriodExpiresAt !== null && gracePeriodExpiresAt > now) return false
  return true
}

export function computeMfaStatus({
  orgRole,
  mfaEnrolledAt,
  gracePeriodExpiresAt,
  now = new Date(),
}: {
  orgRole: OrgRole
  mfaEnrolledAt: Date | null
  gracePeriodExpiresAt: Date | null
  now?: Date
}): ComputedMfaStatus {
  const mfaEnrolled = mfaEnrolledAt !== null
  const enrollmentRequired = isMfaEnforcementActive(
    orgRole,
    mfaEnrolledAt,
    gracePeriodExpiresAt,
    now
  )
  const gracePeriodActive =
    (orgRole === 'owner' || orgRole === 'admin') &&
    !mfaEnrolled &&
    gracePeriodExpiresAt !== null &&
    gracePeriodExpiresAt > now
  const gracePeriodDaysRemaining = gracePeriodActive
    ? Math.ceil((gracePeriodExpiresAt.getTime() - now.getTime()) / 86_400_000)
    : null

  return {
    mfaEnrolled,
    mfaStatus: {
      enrollmentRequired,
      gracePeriodActive,
      gracePeriodExpiresAt: gracePeriodActive ? gracePeriodExpiresAt.toISOString() : null,
      gracePeriodDaysRemaining,
      bannerMessage: gracePeriodActive
        ? `MFA enrollment is required for Owner and Admin roles within ${gracePeriodDaysRemaining} days. Enroll at /settings/security.`
        : enrollmentRequired
          ? MFA_REQUIRED_MESSAGE
          : null,
    },
  }
}

export async function loadMfaEnforcementStatus(authContext: {
  userId: string
  orgId: string
  orgRole: OrgRole
}): Promise<ComputedMfaStatus> {
  const [user] = await getDb()
    .select({ mfaEnrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, authContext.userId))
    .limit(1)

  const [membership] = await withOrg(authContext.orgId, (tx) =>
    tx
      .select({ gracePeriodExpiresAt: orgMemberships.gracePeriodExpiresAt })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, authContext.orgId),
          eq(orgMemberships.userId, authContext.userId),
          eq(orgMemberships.status, 'active')
        )
      )
      .limit(1)
  )

  return computeMfaStatus({
    orgRole: authContext.orgRole,
    mfaEnrolledAt: user?.mfaEnrolledAt ?? null,
    gracePeriodExpiresAt: membership?.gracePeriodExpiresAt ?? null,
  })
}

export function requireMfaEnrollment() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authContext) {
      return reply
        .status(401)
        .send({ code: 'access_token_missing', message: 'Authentication required' })
    }

    const status = await loadMfaEnforcementStatus(request.authContext)
    if (status.mfaStatus.enrollmentRequired) {
      request.log.warn({
        eventType: 'security.mfa_enrollment_required_denied',
        userId: request.authContext.userId,
        orgId: request.authContext.orgId,
        orgRole: request.authContext.orgRole,
        route: request.routeOptions.url,
      })
      return reply.status(403).send({ code: 'mfa_required', message: MFA_REQUIRED_MESSAGE })
    }
    if (status.mfaStatus.gracePeriodActive && status.mfaStatus.gracePeriodExpiresAt) {
      reply.header('X-MFA-Grace-Expires-At', status.mfaStatus.gracePeriodExpiresAt)
    }
  }
}
