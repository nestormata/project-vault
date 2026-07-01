import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import {
  orgMemberships,
  projectInvitations,
  projectMemberships,
  projects,
  users,
} from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { normalizeEmail } from '../auth/normalize.js'
import { findInvitationByTokenHash, validateInvitationStatus } from './lookup.js'
import { hashInvitationToken } from './tokens.js'
import {
  InvitationAcceptResponseSchema,
  InvitationPeekResponseSchema,
  InvitationTokenParamsSchema,
} from './schema.js'
import type { ProjectInvitation } from '@project-vault/db/schema'
import type { FastifyReply } from 'fastify'

type AuthOnlyContext = { auth: SecureRouteContext['auth'] }
type InvitationLookup = { invitation: ProjectInvitation } | { invitation: null }

/** Canonical status-code taxonomy shared by the peek, accept, and registration endpoints. */
async function loadInvitationOrFail(token: string, reply: FastifyReply): Promise<InvitationLookup> {
  const invitation = await findInvitationByTokenHash(hashInvitationToken(token))
  const statusError = validateInvitationStatus(invitation)
  if (statusError) {
    reply
      .status(statusError.statusCode)
      .send({ code: statusError.code, message: statusError.message })
    return { invitation: null }
  }
  return { invitation: invitation as ProjectInvitation }
}

/** Scoped to prefix '/api/v1/invitations' — public peek + authenticated accept. */
export async function invitationTokenRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/:token',
    schema: {
      response: {
        200: InvitationPeekResponseSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/invitations/:token' },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(InvitationTokenParamsSchema, req, reply)
      if (!params) return reply
      const lookup = await loadInvitationOrFail(params.token, reply)
      if (!lookup.invitation) return reply
      const invitation = lookup.invitation

      const [project] = await withOrg(invitation.orgId, (tx) =>
        tx
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, invitation.projectId))
          .limit(1)
      )
      const [existingUser] = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, invitation.email))
        .limit(1)

      return {
        data: {
          email: invitation.email,
          projectName: project?.name ?? '',
          role: invitation.roleToAssign,
          accountExists: Boolean(existingUser),
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:token/accept',
    schema: {
      response: {
        200: InvitationAcceptResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: true,
      requireOrgScope: false,
      requireMfa: false,
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000 },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(InvitationTokenParamsSchema, req, reply)
      if (!params) return reply
      const authCtx = ctx as AuthOnlyContext
      const lookup = await loadInvitationOrFail(params.token, reply)
      if (!lookup.invitation) return reply
      const invitation = lookup.invitation

      const [callerUser] = await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, authCtx.auth.userId))
        .limit(1)
      if (!callerUser || normalizeEmail(callerUser.email) !== normalizeEmail(invitation.email)) {
        return reply.status(403).send({
          code: 'invitation_email_mismatch',
          message: 'This invitation was not addressed to your account',
        })
      }

      const project = await withOrg(invitation.orgId, async (tx) => {
        // Not SecureRoute-managed (requireOrgScope: false — the org isn't known until the
        // token resolves above), so this mirrors the shape by hand for the audit write below.
        const secureCtx: SecureRouteContext = { auth: authCtx.auth, tx, audit: {} }
        const [existingOrgMembership] = await secureCtx.tx
          .select({ userId: orgMemberships.userId })
          .from(orgMemberships)
          .where(
            and(
              eq(orgMemberships.orgId, invitation.orgId),
              eq(orgMemberships.userId, secureCtx.auth.userId)
            )
          )
          .limit(1)
        if (!existingOrgMembership) {
          await secureCtx.tx.insert(orgMemberships).values({
            orgId: invitation.orgId,
            userId: secureCtx.auth.userId,
            role: 'member',
            status: 'active',
          })
        }

        await secureCtx.tx
          .insert(projectMemberships)
          .values({
            orgId: invitation.orgId,
            projectId: invitation.projectId,
            userId: secureCtx.auth.userId,
            role: invitation.roleToAssign,
          })
          .onConflictDoNothing()

        await secureCtx.tx
          .update(projectInvitations)
          .set({ acceptedAt: new Date() })
          .where(eq(projectInvitations.id, invitation.id))

        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          resourceType: 'project_invitation',
          orgId: invitation.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.PROJECT_INVITATION_ACCEPTED,
          resourceId: invitation.id,
          payload: { projectId: invitation.projectId },
          request: req,
        })

        const [projectRow] = await secureCtx.tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.id, invitation.projectId))
          .limit(1)
        return projectRow
      })

      return {
        data: {
          projectId: invitation.projectId,
          projectName: project?.name ?? '',
          role: invitation.roleToAssign,
        },
      }
    },
  })
}
