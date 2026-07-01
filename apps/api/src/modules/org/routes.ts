import { and, eq, ne, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import { orgMemberships, projectMemberships, projects, users } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import { secureRoute, roleRank, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { revokeAllUserSessionsInOrg } from '../auth/session-revoke.js'
import { listSecurityAlerts } from './security-alerts.js'
import {
  OrgUserParamsSchema,
  OrgUserProjectRoleParamsSchema,
  OrgUserRemovedResponseSchema,
  OrgUsersListResponseSchema,
  ProjectRoleChangeBodySchema,
  ProjectRoleChangeResponseSchema,
  SecurityAlertsQuerySchema,
} from './schema.js'

export async function orgRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/security-alerts',
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

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/users/:userId/sessions',
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
        return reply.status(404).send({ code: 'user_not_found', message: 'User not found' })
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

      const orgUsers = await secureCtx.tx
        .select({ userId: orgMemberships.userId, email: users.email, orgRole: orgMemberships.role })
        .from(orgMemberships)
        .innerJoin(users, eq(users.id, orgMemberships.userId))
        .where(eq(orgMemberships.orgId, secureCtx.auth.orgId))

      const projectRows = await secureCtx.tx
        .select({
          userId: projectMemberships.userId,
          projectId: projectMemberships.projectId,
          projectName: projects.name,
          role: projectMemberships.role,
        })
        .from(projectMemberships)
        .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
        .where(eq(projectMemberships.orgId, secureCtx.auth.orgId))

      const projectsByUser = new Map<
        string,
        { projectId: string; projectName: string; role: string }[]
      >()
      for (const row of projectRows) {
        const list = projectsByUser.get(row.userId) ?? []
        list.push({ projectId: row.projectId, projectName: row.projectName, role: row.role })
        projectsByUser.set(row.userId, list)
      }

      return {
        data: orgUsers.map((u) => ({
          userId: u.userId,
          email: u.email,
          displayName: u.email, // D3: no dedicated profile column; derive from email.
          orgRole: u.orgRole,
          projects: projectsByUser.get(u.userId) ?? [],
        })),
      }
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
        409: ApiErrorSchema,
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
      if (params.userId === secureCtx.auth.userId) {
        return reply.status(403).send({
          code: 'cannot_modify_self',
          message: 'You cannot remove yourself from the organization',
        })
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
      if (!target) {
        return reply.status(404).send({ code: 'user_not_found', message: 'User not found' })
      }

      // D9: cannot act on a peer/superior org role.
      if (roleRank(target.orgRole as OrgRole) >= roleRank(secureCtx.auth.orgRole)) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Cannot remove a user with an equal or higher organization role',
        })
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

      const removedProjects = await secureCtx.tx
        .delete(projectMemberships)
        .where(
          and(
            eq(projectMemberships.orgId, secureCtx.auth.orgId),
            eq(projectMemberships.userId, params.userId)
          )
        )
        .returning({ projectId: projectMemberships.projectId })

      await secureCtx.tx
        .delete(orgMemberships)
        .where(
          and(
            eq(orgMemberships.orgId, secureCtx.auth.orgId),
            eq(orgMemberships.userId, params.userId)
          )
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
        payload: { removedProjectCount: removedProjects.length },
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

      const [membership] = await secureCtx.tx
        .select({ role: projectMemberships.role })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, params.projectId),
            eq(projectMemberships.userId, params.userId),
            eq(projectMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .limit(1)
      if (!membership) {
        return reply.status(404).send({
          code: 'membership_not_found',
          message: 'User is not a member of this project',
        })
      }

      // D5 item 3: cannot demote an existing owner via this endpoint.
      if (membership.role === 'owner') {
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
          oldRole: membership.role,
          newRole: parsed.data.role,
        },
        request: req,
      })

      return {
        data: { userId: params.userId, projectId: params.projectId, role: parsed.data.role },
      }
    },
  })
}
