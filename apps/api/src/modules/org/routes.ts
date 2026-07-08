import { z } from 'zod/v4'
import { and, eq, ne, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import { orgMemberships, projectMemberships, users } from '@project-vault/db/schema'
import { ActiveRotationsErrorSchema, AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import { secureRoute, roleRank, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { revokeAllUserSessionsInOrg } from '../auth/session-revoke.js'
import { sendAdminRecoveryLink } from '../auth/recovery.js'
import { checkActiveRotationsForUser, revokePendingInvitationsSentBy } from './deactivation.js'
import { dismissSecurityAlert, listSecurityAlerts } from './security-alerts.js'
import { listOrgUsers, removeUserFromOrgMemberships } from './user-management.js'
import { pseudonymizeUser } from './pseudonymize.js'
import { getProjectMembershipRole } from '../projects/member-management.js'
import {
  AdminRecoveryLinkResponseSchema,
  OrgUserDeactivatedResponseSchema,
  OrgUserParamsSchema,
  OrgUserProjectRoleParamsSchema,
  OrgUserRemovedResponseSchema,
  OrgUsersListResponseSchema,
  OrgUserSessionsRevokedResponseSchema,
  ProjectRoleChangeBodySchema,
  ProjectRoleChangeResponseSchema,
  PseudonymizeBodySchema,
  PseudonymizeResponseSchema,
  securityAlertsResponseSchema,
  SecurityAlertDismissBodySchema,
  SecurityAlertParamsSchema,
  SecurityAlertsQuerySchema,
  SoleOwnerConflictResponseSchema,
} from './schema.js'

const USER_NOT_FOUND = { code: 'user_not_found', message: 'User not found' } as const

/** D4-style self-action block, shared by every route that must reject acting on the caller. */
function blockSelfAction(
  targetUserId: string,
  secureCtx: SecureRouteContext,
  reply: FastifyReply,
  code: string,
  message: string
): boolean {
  if (targetUserId !== secureCtx.auth.userId) return false
  reply.status(403).send({ code, message })
  return true
}

/** 404s (and narrows away `undefined`) a missing target-membership lookup. */
function hasTarget<T>(target: T | undefined, reply: FastifyReply): target is T {
  if (target) return true
  reply.status(404).send(USER_NOT_FOUND)
  return false
}

/** D9 hierarchy guard, shared by every route that acts on a target org member. */
function blockPeerOrHigherRole(
  target: { orgRole: string },
  secureCtx: SecureRouteContext,
  reply: FastifyReply,
  message: string
): boolean {
  if (roleRank(target.orgRole as OrgRole) < roleRank(secureCtx.auth.orgRole)) return false
  reply.status(403).send({ code: 'insufficient_role', message })
  return true
}

/** Combines the two guards above — the shape every target-mutating org route needs. */
function isUsableTarget<T extends { orgRole: string }>(
  target: T | undefined,
  secureCtx: SecureRouteContext,
  reply: FastifyReply,
  hierarchyMessage: string
): target is T {
  if (!hasTarget(target, reply)) return false
  return !blockPeerOrHigherRole(target, secureCtx, reply, hierarchyMessage)
}

export async function orgRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/security-alerts',
    schema: {
      response: {
        200: securityAlertsResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = SecurityAlertsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
      return {
        data: await listSecurityAlerts(secureCtx.auth.orgId, parsed.data, secureCtx.tx),
      }
    },
  })

  // Story 6.2 AC 18 (ADR-6.2-04's correction): closes the pre-existing gap where Story 3.4
  // shipped dismissedBy/dismissedAt/dismissalReason columns on security_alerts with no route to
  // set them. admin+ only — same rationale as the monitoring-alert dismiss route (AC 10): a
  // security_alerts row is a critical, org-admin-routed signal; allowing a bare `member` to
  // unilaterally silence it would let a low-privileged or compromised account suppress it.
  secureRoute(fastify, {
    method: 'POST',
    url: '/security-alerts/:securityAlertId/dismiss',
    schema: {
      response: { 401: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: true, // route-audit.test.ts AC-5b/5c: every owner/admin route requires MFA.
      rateLimit: { max: 60, key: 'POST /org/security-alerts/:securityAlertId/dismiss' },
      writeAuditEvent: false, // dismissSecurityAlert writes the audit row through secureCtx.tx.
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const params = SecurityAlertParamsSchema.safeParse(req.params)
      if (!params.success) return reply.status(422).send(validationError(params.error, 'params'))
      const body = SecurityAlertDismissBodySchema.safeParse(req.body ?? {})
      if (!body.success) return reply.status(422).send(validationError(body.error, 'body'))

      const updated = await dismissSecurityAlert(secureCtx.tx, {
        securityAlertId: params.data.securityAlertId,
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        dismissalReason: body.data.dismissalReason,
        request: req,
      })
      if (!updated) {
        return reply
          .status(404)
          .send({ code: 'security_alert_not_found', message: 'Security alert not found' })
      }

      return {
        data: { id: updated.id, dismissedAt: updated.dismissedAt?.toISOString() ?? null },
      }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/users/:userId/sessions',
    schema: {
      response: {
        200: OrgUserSessionsRevokedResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['admin', 'owner'],
      requireMfa: true,
      rateLimit: { max: 20, key: 'DELETE /org/users/:userId/sessions' },
      writeAuditEvent: false, // Session service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = OrgUserParamsSchema.safeParse(req.params)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'params'))

      const targetMembership = await secureCtx.tx
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, parsed.data.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId),
            eq(orgMemberships.status, 'active')
          )
        )
        .limit(1)
      if (!targetMembership[0]) {
        return reply.status(404).send(USER_NOT_FOUND)
      }

      const result = await revokeAllUserSessionsInOrg({
        userId: parsed.data.userId,
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        reason: 'admin_action',
        tx: secureCtx.tx,
      })

      return { data: { ...result, userId: parsed.data.userId } }
    },
  })

  // Story 4.3 AC-2 through AC-8: deactivate a user in this org (immediate session/invitation
  // revocation; D7-stubbed rotation-block check pending Epic 5).
  secureRoute(fastify, {
    method: 'POST',
    url: '/users/:userId/deactivate',
    schema: {
      response: {
        200: OrgUserDeactivatedResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([ApiErrorSchema, ActiveRotationsErrorSchema]),
      },
    },
    security: {
      allowedRoles: ['admin', 'owner'],
      requireMfa: true,
      writeAuditEvent: false, // Audit row written inline below, in the same secureCtx.tx.
      rateLimit: { max: 20, key: 'POST /org/users/:userId/deactivate' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const params = parseParams(OrgUserParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      if (
        blockSelfAction(
          params.userId,
          secureCtx,
          reply,
          'cannot_deactivate_self',
          'You cannot deactivate your own account'
        )
      ) {
        return reply
      }

      // AC-3 edge case: lock the target row before evaluating hierarchy/idempotency so a
      // concurrent role change or a racing deactivation call (AC-19) is re-checked, not raced.
      const [target] = await secureCtx.tx
        .select({ orgRole: orgMemberships.role, status: orgMemberships.status })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, params.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .for('update')
        .limit(1)
      if (
        !isUsableTarget(
          target,
          secureCtx,
          reply,
          'Cannot deactivate a user with an equal or higher organization role'
        )
      ) {
        return reply
      }

      if (target.status === 'deactivated') {
        return reply
          .status(409)
          .send({ code: 'already_deactivated', message: 'User is already deactivated' })
      }

      await secureCtx.tx
        .update(orgMemberships)
        .set({ status: 'deactivated', updatedAt: new Date() })
        .where(
          and(
            eq(orgMemberships.userId, params.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId)
          )
        )

      // FR84/PJ3 reuse — revokeAllUserSessionsInOrg is the single, tested session-revocation
      // primitive (Story 1.7); never reimplement this here.
      const { revokedCount: revokedSessionCount } = await revokeAllUserSessionsInOrg({
        userId: params.userId,
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        reason: 'deactivation',
        tx: secureCtx.tx,
      })

      const revokedInvitationCount = await revokePendingInvitationsSentBy(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        userId: params.userId,
      })

      // D7 stub — never blocks today (checkActiveRotationsForUser always returns
      // blocked: false); see deactivation.ts for the Epic 5 forward-dependency note. Branching on
      // the result now, even though it's always false, means Epic 5 only has to fill in the
      // function body — this call site won't also need to be remembered and updated.
      const rotationCheck = await checkActiveRotationsForUser(
        params.userId,
        secureCtx.auth.orgId,
        secureCtx.tx
      )
      if (rotationCheck.blocked) {
        // ADR-4.4-04: byte-compatible with Story 4.4's archive guard — `error`, not `code`, and
        // carries `rotationIds` — so clients handle either endpoint's active-rotation block the
        // same way once Epic 5 replaces both stubs with a real check.
        return reply
          .status(409)
          .send({ error: 'active_rotations', rotationIds: rotationCheck.rotationIds })
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'org_membership',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.ORG_USER_DEACTIVATED,
        resourceId: params.userId,
        payload: { revokedSessionCount, revokedInvitationCount },
        request: req,
      })

      return { data: { userId: params.userId, revokedSessionCount, revokedInvitationCount } }
    },
  })

  // Story 4.3 AC-10: admin-initiated recovery link — sends the same 15-minute link a self-
  // service request would, for a teammate who can't reach the self-service flow (Persona C).
  secureRoute(fastify, {
    method: 'POST',
    url: '/users/:userId/recovery/send-link',
    schema: {
      response: {
        200: AdminRecoveryLinkResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['admin', 'owner'],
      requireMfa: true,
      writeAuditEvent: false, // Audit row written inline below, in the same secureCtx.tx.
      rateLimit: { max: 20, key: 'POST /org/users/:userId/recovery/send-link' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const params = parseParams(OrgUserParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const [target] = await secureCtx.tx
        .select({ email: users.email, orgRole: orgMemberships.role })
        .from(orgMemberships)
        .innerJoin(users, eq(users.id, orgMemberships.userId))
        .where(
          and(
            eq(orgMemberships.userId, params.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .limit(1)
      // Adversarial-review hardening: a forced credential-reset link is at least as sensitive as
      // deactivation (AC-3) — apply the same D9 peer-or-higher guard, even though the AC text
      // for this route doesn't spell it out (it also doesn't rule it out).
      if (
        !isUsableTarget(
          target,
          secureCtx,
          reply,
          'Cannot send a recovery link to a user with an equal or higher organization role'
        )
      ) {
        return reply
      }

      const [caller] = await secureCtx.tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, secureCtx.auth.userId))
        .limit(1)

      await sendAdminRecoveryLink(secureCtx.tx, {
        targetUserId: params.userId,
        targetEmail: target.email,
        initiatorOrgId: secureCtx.auth.orgId,
        initiatorEmail: caller?.email ?? '',
      })

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'account_recovery',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.ACCOUNT_RECOVERY_LINK_SENT,
        resourceId: params.userId,
        payload: { targetUserId: params.userId, initiatedBy: 'admin' },
        request: req,
      })

      return { data: { userId: params.userId, linkSent: true } }
    },
  })

  // AC-2: list every org user with their cross-project roles.
  secureRoute(fastify, {
    method: 'GET',
    url: '/users',
    schema: {
      response: { 200: OrgUsersListResponseSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: false,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/org/users' },
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      return { data: await listOrgUsers(secureCtx.tx, secureCtx.auth.orgId) }
    },
  })

  // AC-3: remove a user from the organization (cascade project memberships + revoke sessions).
  secureRoute(fastify, {
    method: 'DELETE',
    url: '/users/:userId',
    schema: {
      response: {
        200: OrgUserRemovedResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        // 409 covers both last_org_owner (plain ApiError) and sole_owner_of_projects (carries
        // the offending `projects` array). A union keeps `projects` from being serialized away.
        409: z.union([SoleOwnerConflictResponseSchema, ApiErrorSchema]),
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true, // D2 — standard grace-respecting gate.
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'DELETE /api/v1/org/users/:userId' },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(OrgUserParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      // D4: self-removal is blocked. Cheapest check, before any DB access.
      if (
        blockSelfAction(
          params.userId,
          secureCtx,
          reply,
          'cannot_modify_self',
          'You cannot remove yourself from the organization'
        )
      ) {
        return reply
      }

      const [target] = await secureCtx.tx
        .select({ userId: orgMemberships.userId, orgRole: orgMemberships.role })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, params.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .limit(1)
      // D9: cannot act on a peer/superior org role.
      if (
        !isUsableTarget(
          target,
          secureCtx,
          reply,
          'Cannot remove a user with an equal or higher organization role'
        )
      ) {
        return reply
      }

      // D5 item 4: never remove the sole org owner (checked before the per-project guard —
      // an ownerless org is categorically worse than an ownerless project).
      if (target.orgRole === 'owner') {
        const otherOwners = await secureCtx.tx
          .select({ userId: orgMemberships.userId })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.orgId, secureCtx.auth.orgId),
              eq(orgMemberships.role, 'owner'),
              ne(orgMemberships.userId, params.userId)
            )
          )
          .for('update')
        if (otherOwners.length === 0) {
          return reply.status(409).send({
            code: 'last_org_owner',
            message: 'Cannot remove the sole owner of the organization',
          })
        }
      }

      // D5 item 2: block if the target is the sole owner of any project.
      const soleOwnerProjects = await secureCtx.tx.execute(sql`
        SELECT pm.project_id AS "projectId", p.name AS "projectName"
        FROM project_memberships pm
        JOIN projects p ON p.id = pm.project_id
        WHERE pm.org_id = ${secureCtx.auth.orgId}
          AND pm.user_id = ${params.userId}
          AND pm.role = 'owner'
          AND NOT EXISTS (
            SELECT 1 FROM project_memberships pm2
            WHERE pm2.project_id = pm.project_id
              AND pm2.role = 'owner'
              AND pm2.user_id != ${params.userId}
          )
        FOR UPDATE OF pm
      `)
      const soleOwnerRows = soleOwnerProjects as unknown as {
        projectId: string
        projectName: string
      }[]
      if (soleOwnerRows.length > 0) {
        return reply.status(409).send({
          code: 'sole_owner_of_projects',
          message: 'Transfer ownership of these projects before removing this user',
          projects: soleOwnerRows,
        })
      }

      const { removedProjectCount } = await removeUserFromOrgMemberships(
        secureCtx.tx,
        secureCtx.auth.orgId,
        params.userId
      )

      // FR84 reuse — revokeAllUserSessionsInOrg writes its own SESSION_REVOKED audit rows.
      const { revokedCount } = await revokeAllUserSessionsInOrg({
        userId: params.userId,
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        reason: 'admin_action',
        tx: secureCtx.tx,
      })

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'org_membership',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.ORG_USER_REMOVED,
        resourceId: params.userId,
        payload: { removedProjectCount },
        request: req,
      })

      return { data: { userId: params.userId, revokedSessionCount: revokedCount } }
    },
  })

  // AC-4: change a user's project role (never 'owner' — D6).
  secureRoute(fastify, {
    method: 'PUT',
    url: '/users/:userId/projects/:projectId/role',
    schema: {
      body: ProjectRoleChangeBodySchema,
      response: {
        200: ProjectRoleChangeResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'PUT /api/v1/org/users/:userId/projects/:projectId/role',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(OrgUserProjectRoleParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(ProjectRoleChangeBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      // D4: cannot change your own project role.
      if (params.userId === secureCtx.auth.userId) {
        return reply
          .status(403)
          .send({ code: 'cannot_modify_self', message: 'You cannot change your own project role' })
      }

      // D9: compare the target's org role to the caller's org rank.
      const [targetOrg] = await secureCtx.tx
        .select({ orgRole: orgMemberships.role })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, params.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .limit(1)
      // If the target is not in the caller's org at all, let the membership lookup below
      // produce the standard 404 (enumeration-prevention); skip the D9 comparison here.
      if (targetOrg && roleRank(targetOrg.orgRole as OrgRole) >= roleRank(secureCtx.auth.orgRole)) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Cannot modify a user with an equal or higher organization role',
        })
      }

      // NFR-SEC10 role-elevation check (currently unreachable via HTTP — see Dev Notes).
      if (roleRank(parsed.data.role as OrgRole) > roleRank(secureCtx.auth.orgRole)) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Cannot assign a role higher than your own',
        })
      }

      const membershipRole = await getProjectMembershipRole(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: params.userId,
      })
      if (!membershipRole) {
        return reply.status(404).send({
          code: 'membership_not_found',
          message: 'User is not a member of this project',
        })
      }

      // D5 item 3: cannot demote an existing owner via this endpoint.
      if (membershipRole === 'owner') {
        return reply.status(409).send({
          code: 'must_transfer_ownership_first',
          message: 'Use transfer-ownership to change the project owner',
        })
      }

      await secureCtx.tx
        .update(projectMemberships)
        .set({ role: parsed.data.role })
        .where(
          and(
            eq(projectMemberships.projectId, params.projectId),
            eq(projectMemberships.userId, params.userId)
          )
        )

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project_membership',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_MEMBER_ROLE_CHANGED,
        resourceId: params.userId,
        payload: {
          projectId: params.projectId,
          oldRole: membershipRole,
          newRole: parsed.data.role,
        },
        request: req,
      })

      return {
        data: { userId: params.userId, projectId: params.projectId, role: parsed.data.role },
      }
    },
  })

  // Story 8.3 AC-17 through AC-22 — owner-only, irreversible pseudonymization of a departed/
  // erasure-subject user's audit-trail identity (FR44). `writeAuditEvent: false` + a manual
  // writeHumanAuditEntryOrFailClosed call below: the payload includes tokensPseudonymized/
  // otherAffectedOrgCount/otherAffectedOrgIds, none of which the default SecureRoute audit
  // writer's `{ params, query }`-only payload callback could compute.
  secureRoute(fastify, {
    method: 'POST',
    url: '/users/:userId/pseudonymize',
    schema: {
      body: PseudonymizeBodySchema,
      response: {
        200: PseudonymizeResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner'],
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/org/users/:userId/pseudonymize',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(OrgUserParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(PseudonymizeBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      // AC-20 edge case: 404 (not 403) for a target who isn't a member of the caller's org —
      // matches the existing non-leaking-404-for-cross-org-target convention (organization-
      // settings-routes.ts, org/routes.ts's own deactivate handler) — checked before any mutation.
      const [target] = await secureCtx.tx
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, params.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .limit(1)
      if (!target) return reply.status(404).send(USER_NOT_FOUND)

      // AC-17a — must reject before any mutation; the caller must re-type the exact target
      // userId to confirm this irreversible, cross-org-impacting action (D9).
      if (parsed.data.confirmUserId !== params.userId) {
        return reply.status(422).send({
          code: 'confirmation_required',
          message: 'confirmUserId must match the target user to confirm this irreversible action',
        })
      }

      const result = await pseudonymizeUser(secureCtx.tx, {
        targetUserId: params.userId,
        callerOrgId: secureCtx.auth.orgId,
      })

      // D9/finding-5/6/15 — the audit payload records the cross-org blast radius (org IDs and a
      // count only — no PII) so a future investigation in this org can answer "how many other
      // orgs were affected by this specific call" without re-deriving it from scratch.
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'user_identity_token',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.USER_PSEUDONYMIZED,
        resourceId: params.userId,
        payload: {
          targetUserId: params.userId,
          tokensPseudonymized: result.tokensPseudonymized,
          otherAffectedOrgCount: result.otherAffectedOrgCount,
          otherAffectedOrgIds: result.otherAffectedOrgIds,
        },
        request: req,
      })

      return {
        data: {
          userId: params.userId,
          pseudonymized: true as const,
          pseudonymizedAt: result.pseudonymizedAt.toISOString(),
          alias: result.alias,
          otherAffectedOrgCount: result.otherAffectedOrgCount,
        },
      }
    },
  })
}
