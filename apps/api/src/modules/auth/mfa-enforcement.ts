import { and, eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getDb, withOrg, type Tx } from '@project-vault/db'
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

  let bannerMessage: string | null
  if (gracePeriodActive) {
    bannerMessage = `MFA enrollment is required for Owner and Admin roles within ${gracePeriodDaysRemaining} days. Enroll at /settings/security.`
  } else if (enrollmentRequired) {
    bannerMessage = MFA_REQUIRED_MESSAGE
  } else {
    bannerMessage = null
  }

  return {
    mfaEnrolled,
    mfaStatus: {
      enrollmentRequired,
      gracePeriodActive,
      gracePeriodExpiresAt: gracePeriodActive ? gracePeriodExpiresAt.toISOString() : null,
      gracePeriodDaysRemaining,
      bannerMessage,
    },
  }
}

export async function loadMfaEnforcementStatus(
  authContext: {
    userId: string
    orgId: string
    orgRole: OrgRole
  },
  tx?: Tx
): Promise<ComputedMfaStatus> {
  const db = tx ?? getDb()
  const [user] = await db
    .select({ mfaEnrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, authContext.userId))
    .limit(1)

  const loadMembership = (db: Tx) =>
    db
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
  const [membership] = tx
    ? await loadMembership(tx)
    : await withOrg(authContext.orgId, loadMembership)

  return computeMfaStatus({
    orgRole: authContext.orgRole,
    mfaEnrolledAt: user?.mfaEnrolledAt ?? null,
    gracePeriodExpiresAt: membership?.gracePeriodExpiresAt ?? null,
  })
}

/**
 * Strict MFA gate for the project-invitation route (D2, Story 4.1): unlike
 * requireMfaEnrollment(), this ignores an active grace period — the MFA policy matrix
 * requires invites to be blocked for unenrolled owner/admin even during grace.
 */
export function requireMfaEnrollmentStrict() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authContext) {
      reply.status(401).send({ code: 'access_token_missing', message: 'Authentication required' })
      return
    }
    const { orgRole, userId } = request.authContext
    if (orgRole !== 'owner' && orgRole !== 'admin') return
    const [user] = await getDb()
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    if (!user?.mfaEnrolledAt) {
      reply.status(403).send({ code: 'mfa_required', message: MFA_REQUIRED_MESSAGE })
    }
  }
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
