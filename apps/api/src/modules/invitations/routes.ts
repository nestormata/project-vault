import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  notificationQueue,
  projectInvitations,
  projectMemberships,
  projects,
  users,
  type ProjectInvitation,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, roleRank, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { env } from '../../config/env.js'
import { requireMfaEnrollmentStrict } from '../auth/mfa-enforcement.js'
import { generateInvitationToken, hashInvitationToken } from './tokens.js'
import {
  CreateInvitationBodySchema,
  CreateInvitationResponseSchema,
  InvitationListResponseSchema,
  ProjectInvitationParamsSchema,
  RevokeInvitationParamsSchema,
} from './schema.js'

const INVITATION_EXPIRY_MS = 72 * 60 * 60 * 1000
const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const

async function findExistingProjectMember(
  tx: Tx,
  projectId: string,
  email: string
): Promise<boolean> {
  const [existingMember] = await tx
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .innerJoin(users, eq(users.id, projectMemberships.userId))
    .where(and(eq(projectMemberships.projectId, projectId), eq(users.email, email)))
    .limit(1)
  return Boolean(existingMember)
}

async function upsertPendingInvitation(
  tx: Tx,
  input: { orgId: string; projectId: string; email: string; role: string; invitedBy: string }
): Promise<{ invitation: ProjectInvitation; opaqueToken: string }> {
  const [pending] = await tx
    .select({ id: projectInvitations.id })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, input.projectId),
        eq(projectInvitations.email, input.email),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
        gt(projectInvitations.expiresAt, new Date())
      )
    )
    .limit(1)

  const opaqueToken = generateInvitationToken()
  const tokenHash = hashInvitationToken(opaqueToken)
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS)

  const invitation = pending
    ? (
        await tx
          .update(projectInvitations)
          .set({ expiresAt, tokenHash, roleToAssign: input.role })
          .where(eq(projectInvitations.id, pending.id))
          .returning()
      )[0]
    : (
        await tx
          .insert(projectInvitations)
          .values({
            orgId: input.orgId,
            projectId: input.projectId,
            email: input.email,
            roleToAssign: input.role,
            tokenHash,
            invitedBy: input.invitedBy,
            expiresAt,
          })
          .returning()
      )[0]
  if (!invitation) throw new Error('project invitation insert/update returned no row')
  return { invitation, opaqueToken }
}

async function enqueueInvitationEmail(
  tx: Tx,
  input: {
    orgId: string
    inviterUserId: string
    email: string
    role: string
    project: { id: string; name: string }
    opaqueToken: string
  }
): Promise<void> {
  const [inviter] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.inviterUserId))
    .limit(1)

  await tx.insert(notificationQueue).values({
    orgId: input.orgId,
    recipientUserId: null,
    recipientEmail: input.email,
    channel: 'email',
    templateId: 'project.invitation_created',
    payload: {
      projectId: input.project.id,
      projectName: input.project.name,
      inviterEmail: inviter?.email ?? null,
      role: input.role,
      acceptUrl: `${env.WEB_BASE_URL}/invitations/accept?token=${input.opaqueToken}`,
    },
    status: 'pending',
  })
}

/** Scoped to prefix '/api/v1/projects' — create/list/revoke invitations for a project. */
export async function projectInvitationRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/invitations',
    schema: {
      response: {
        201: CreateInvitationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/invitations',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectInvitationParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(CreateInvitationBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      // D2: strict MFA gate — ignores grace period, unlike security.requireMfa's
      // requireMfaEnrollment(). Must run before any invitation logic.
      await requireMfaEnrollmentStrict()(req, reply)
      if (reply.sent) return reply

      if (roleRank(parsed.data.role) > roleRank(secureCtx.auth.orgRole)) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Cannot invite to a role higher than your own',
        })
      }

      const [project] = await secureCtx.tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
        .limit(1)
      if (!project) return reply.status(404).send(PROJECT_NOT_FOUND)

      if (await findExistingProjectMember(secureCtx.tx, params.projectId, parsed.data.email)) {
        return reply
          .status(409)
          .send({ code: 'already_member', message: 'User is already a project member' })
      }

      const { invitation, opaqueToken } = await upsertPendingInvitation(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        email: parsed.data.email,
        role: parsed.data.role,
        invitedBy: secureCtx.auth.userId,
      })

      await enqueueInvitationEmail(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        inviterUserId: secureCtx.auth.userId,
        email: parsed.data.email,
        role: parsed.data.role,
        project,
        opaqueToken,
      })

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project_invitation',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_INVITATION_CREATED,
        resourceId: invitation.id,
        payload: { email: parsed.data.email, role: parsed.data.role, projectId: params.projectId },
        request: req,
      })

      reply.status(201)
      return {
        data: {
          id: invitation.id,
          projectId: invitation.projectId,
          email: invitation.email,
          roleToAssign: invitation.roleToAssign,
          invitedBy: invitation.invitedBy,
          expiresAt: invitation.expiresAt.toISOString(),
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/invitations',
    schema: {
      response: { 200: InvitationListResponseSchema, 401: ApiErrorSchema },
    },
    security: { minimumRole: 'admin', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectInvitationParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const rows = await secureCtx.tx
        .select({
          id: projectInvitations.id,
          email: projectInvitations.email,
          roleToAssign: projectInvitations.roleToAssign,
          invitedBy: projectInvitations.invitedBy,
          expiresAt: projectInvitations.expiresAt,
        })
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.projectId, params.projectId),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
            gt(projectInvitations.expiresAt, new Date())
          )
        )
        .orderBy(desc(projectInvitations.expiresAt))

      return {
        data: rows.map((row) => ({ ...row, expiresAt: row.expiresAt.toISOString() })),
      }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/invitations/:id',
    security: { minimumRole: 'admin', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RevokeInvitationParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const [existing] = await secureCtx.tx
        .select({
          id: projectInvitations.id,
          acceptedAt: projectInvitations.acceptedAt,
          revokedAt: projectInvitations.revokedAt,
        })
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.id, params.id),
            eq(projectInvitations.projectId, params.projectId)
          )
        )
        .limit(1)
      if (!existing) {
        return reply
          .status(404)
          .send({ code: 'invitation_not_found', message: 'Invitation not found' })
      }
      if (existing.acceptedAt) {
        return reply
          .status(409)
          .send({ code: 'already_accepted', message: 'Invitation has already been accepted' })
      }

      if (!existing.revokedAt) {
        await secureCtx.tx
          .update(projectInvitations)
          .set({ revokedAt: new Date() })
          .where(eq(projectInvitations.id, params.id))

        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          resourceType: 'project_invitation',
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.PROJECT_INVITATION_REVOKED,
          resourceId: params.id,
          payload: {},
          request: req,
        })
      }

      reply.status(204)
      return undefined
    },
  })
}
