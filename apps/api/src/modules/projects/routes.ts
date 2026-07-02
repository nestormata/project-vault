import { and, desc, eq, isNull, ne } from 'drizzle-orm'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { dedupeTags, tagDelta } from '../../lib/tags.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { projectMemberships, projects, users } from '@project-vault/db/schema'
import {
  CreateProjectBodySchema,
  PatchProjectBodySchema,
  PatchProjectResponseSchema,
  ProjectCreateResponseSchema,
  ProjectDashboardResponseSchema,
  ProjectListResponseSchema,
  ProjectMemberParamsSchema,
  ProjectMembersListResponseSchema,
  ProjectParamsSchema,
  ProjectTagUpdateResponseSchema,
  TagArrayBodySchema,
  TransferOwnershipBodySchema,
  TransferOwnershipResponseSchema,
  type CreateProjectBody,
  type PatchProjectBody,
} from './schema.js'
import {
  getBatchedProjectCredentialStats,
  getProjectDashboardData,
  lookupProjectStats,
} from './dashboard-stats.js'
import { removeProjectMembership } from './member-management.js'

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const

// Inline project-role lookup — see 4.1 D-notes / 4.4 AC-2 for why this isn't centralized as a
// cross-module resolver yet; 3rd cross-story occurrence as of 4.2, consider extracting if a 4th
// consumer appears. This module-local helper only dedupes the identical query across this file's
// three new handlers (AC-5/AC-6/AC-10); it is not the shared resolver D8 defers.
async function callerProjectRole(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<string | undefined> {
  const [membership] = await secureCtx.tx
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, secureCtx.auth.userId)
      )
    )
    .limit(1)
  return membership?.role
}

function serializeProjectDetail(project: typeof projects.$inferSelect, role: 'owner') {
  return {
    ...project,
    role,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    archivedAt: project.archivedAt?.toISOString() ?? null,
  }
}

function isProjectSlugTaken(error: unknown): boolean {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (!cause || typeof cause !== 'object') return false
  const pg = cause as { code?: string; constraint?: string; constraint_name?: string }
  return (
    pg.code === '23505' &&
    (pg.constraint === 'idx_projects_org_slug' || pg.constraint_name === 'idx_projects_org_slug')
  )
}

async function createProject(secureCtx: SecureRouteContext, body: CreateProjectBody) {
  try {
    const [project] = await secureCtx.tx
      .insert(projects)
      .values({
        orgId: secureCtx.auth.orgId,
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        createdBy: secureCtx.auth.userId,
      })
      .returning()

    if (!project) throw new Error('Project insert returned no row')

    await secureCtx.tx.insert(projectMemberships).values({
      orgId: secureCtx.auth.orgId,
      projectId: project.id,
      userId: secureCtx.auth.userId,
      role: 'owner',
    })

    return { project, detail: serializeProjectDetail(project, 'owner') }
  } catch (error) {
    if (isProjectSlugTaken(error)) {
      return {
        error: {
          code: 'slug_taken',
          message: 'A project with this slug already exists in your organization',
        },
      }
    }
    throw error
  }
}

export async function projectRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '',
    schema: {
      response: {
        201: ProjectCreateResponseSchema,
        401: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      requireMfa: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'POST /api/v1/projects' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsed = parseBody(CreateProjectBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext
      const result = await createProject(secureCtx, parsed.data)
      if ('error' in result) return reply.status(409).send(result.error)
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'project.created',
        resourceId: result.project.id,
        payload: { slug: result.project.slug },
        request: req,
      })
      reply.status(201)
      return { data: result.detail }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '',
    schema: {
      response: { 200: ProjectListResponseSchema, 401: ApiErrorSchema },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const rows = await secureCtx.tx
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
          role: projectMemberships.role,
          createdAt: projects.createdAt,
        })
        .from(projects)
        .leftJoin(
          projectMemberships,
          and(
            eq(projectMemberships.projectId, projects.id),
            eq(projectMemberships.userId, secureCtx.auth.userId)
          )
        )
        .where(isNull(projects.archivedAt))
        .orderBy(desc(projects.createdAt))

      const statsByProject = await getBatchedProjectCredentialStats(
        secureCtx.tx,
        rows.map((row) => row.id)
      )

      const items = rows.map((row) => {
        const stats = lookupProjectStats(statsByProject, row.id)
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description,
          role: (row.role ?? secureCtx.auth.orgRole) as 'owner' | 'admin' | 'member' | 'viewer',
          credentialCount: stats.credentialCount,
          expiringCount: stats.expiringCount,
          // ADR-3.4-02: security_alerts is org-scoped, not project-scoped — stays 0 here
          // to avoid duplicating the org-wide unresolved count on every project row.
          // The org dashboard (unresolvedAlertCount) is the truthful aggregate until Epic 6.
          alertCount: 0,
          createdAt: row.createdAt.toISOString(),
        }
      })

      return { data: { items, total: items.length } }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/dashboard',
    schema: {
      response: {
        200: ProjectDashboardResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      const rows = await secureCtx.tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
        .limit(1)
      if (!rows[0]) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }
      return { data: await getProjectDashboardData(secureCtx.tx, params.projectId) }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId',
    schema: {
      response: {
        200: PatchProjectResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: false,
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(PatchProjectBodySchema, req, reply)
      if (!parsed.success) return reply
      const body = parsed.data as PatchProjectBody
      const updateSet: { name?: string; description?: string | null; updatedAt?: Date } = {}
      if (body.name !== undefined) updateSet.name = body.name
      if (body.description !== undefined) updateSet.description = body.description
      if (Object.keys(updateSet).length === 0) {
        return reply
          .status(422)
          .send({ code: 'validation_error', message: 'No updatable fields provided' })
      }
      updateSet.updatedAt = new Date()

      const secureCtx = ctx as SecureRouteContext
      const [updated] = await secureCtx.tx
        .update(projects)
        .set(updateSet)
        .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
        .returning({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
          updatedAt: projects.updatedAt,
        })

      if (!updated) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'project.updated',
        resourceId: updated.id,
        payload: {},
        request: req,
      })

      return {
        data: {
          ...updated,
          updatedAt: updated.updatedAt.toISOString(),
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: '/:projectId/tags',
    schema: {
      response: {
        200: ProjectTagUpdateResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'PUT /api/v1/projects/:projectId/tags' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<{ tags: string[] }>(TagArrayBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const [current] = await secureCtx.tx
        .select({ id: projects.id, tags: projects.tags })
        .from(projects)
        .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
        .for('update')
        .limit(1)
      if (!current) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }

      const nextTags = dedupeTags(parsed.data.tags)
      const [updated] = await secureCtx.tx
        .update(projects)
        .set({ tags: nextTags, updatedAt: new Date() })
        .where(eq(projects.id, params.projectId))
        .returning({ id: projects.id, tags: projects.tags })
      if (!updated) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }

      const delta = tagDelta(current.tags, nextTags)
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'project.tags_updated',
        resourceId: updated.id,
        payload: { mode: 'replace', ...delta, resultCount: nextTags.length },
        request: req,
      })

      return { data: updated }
    },
  })

  // AC-10: list accepted members of a single project. Authorized on the project-role axis (D1).
  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/members',
    schema: {
      response: {
        200: ProjectMembersListResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      // Broad floor — real authorization is the in-handler project-axis check below. Must admit
      // org-viewers, since a project admin/owner can be an org-viewer (project-axis wins, D1).
      minimumRole: 'viewer',
      requireMfa: false,
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/projects/:projectId/members' },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const [project] = await secureCtx.tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .limit(1)
      if (!project) return reply.status(404).send(PROJECT_NOT_FOUND)

      const callerRole = await callerProjectRole(secureCtx, params.projectId)
      const isProjectAdminOrOwner = callerRole === 'admin' || callerRole === 'owner'
      const isOrgAdminOrOwner =
        secureCtx.auth.orgRole === 'admin' || secureCtx.auth.orgRole === 'owner'
      if (!isProjectAdminOrOwner && !isOrgAdminOrOwner) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Only project admins/owners or org admins/owners can view the member list',
        })
      }

      const rows = await secureCtx.tx
        .select({
          userId: projectMemberships.userId,
          email: users.email,
          role: projectMemberships.role,
        })
        .from(projectMemberships)
        .innerJoin(users, eq(users.id, projectMemberships.userId))
        .where(eq(projectMemberships.projectId, params.projectId))

      return {
        data: rows.map((row) => ({
          userId: row.userId,
          email: row.email,
          displayName: row.email, // D3
          role: row.role,
        })),
      }
    },
  })

  // AC-5: remove a single project membership. Project-admin/owner OR org-admin/owner (D1).
  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/members/:userId',
    schema: {
      response: {
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      // Broad floor — real authorization is the in-handler project-axis check below. Must admit
      // org-viewers, since a project admin/owner can be an org-viewer (project-axis wins, D1).
      minimumRole: 'viewer',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'DELETE /api/v1/projects/:projectId/members/:userId',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectMemberParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const [targetMembership] = await secureCtx.tx
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
      if (!targetMembership) {
        return reply
          .status(404)
          .send({ code: 'membership_not_found', message: 'User is not a member of this project' })
      }

      const callerRole = await callerProjectRole(secureCtx, params.projectId)
      const isProjectAdminOrOwner = callerRole === 'admin' || callerRole === 'owner'
      const isOrgAdminOrOwner =
        secureCtx.auth.orgRole === 'admin' || secureCtx.auth.orgRole === 'owner'
      if (!isProjectAdminOrOwner && !isOrgAdminOrOwner) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Only project admins/owners or org admins/owners can remove project members',
        })
      }

      // D5 item 1: never remove the last owner of a project (self-removal is no exception).
      if (targetMembership.role === 'owner') {
        const otherOwners = await secureCtx.tx
          .select({ userId: projectMemberships.userId })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.projectId, params.projectId),
              eq(projectMemberships.role, 'owner'),
              ne(projectMemberships.userId, params.userId)
            )
          )
          .for('update')
        if (otherOwners.length === 0) {
          return reply
            .status(409)
            .send({ code: 'last_owner', message: 'Cannot remove the last owner of a project' })
        }
      }

      await removeProjectMembership(secureCtx.tx, params.projectId, params.userId)

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project_membership',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_MEMBER_REMOVED,
        resourceId: params.userId,
        payload: { projectId: params.projectId, removedRole: targetMembership.role },
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })

  // AC-6: transfer project ownership. Project owner OR org owner only (D1).
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/transfer-ownership',
    schema: {
      body: TransferOwnershipBodySchema,
      response: {
        200: TransferOwnershipResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member', // broad floor — real authorization is the in-handler owner check.
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/transfer-ownership',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(TransferOwnershipBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const callerRole = await callerProjectRole(secureCtx, params.projectId)
      const isProjectOwner = callerRole === 'owner'
      const isOrgOwner = secureCtx.auth.orgRole === 'owner'
      if (!isProjectOwner && !isOrgOwner) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Only the project owner can transfer ownership',
        })
      }

      // Self-transfer no-op rejection (request-shape problem — 422).
      if (parsed.data.newOwnerId === secureCtx.auth.userId) {
        return reply
          .status(422)
          .send({ code: 'invalid_new_owner', message: 'Cannot transfer ownership to yourself' })
      }

      // AC-E4c: target must already be an accepted member of the project.
      const [targetMembership] = await secureCtx.tx
        .select({ role: projectMemberships.role })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, params.projectId),
            eq(projectMemberships.userId, parsed.data.newOwnerId),
            eq(projectMemberships.orgId, secureCtx.auth.orgId)
          )
        )
        .limit(1)
      if (!targetMembership) {
        return reply.status(404).send({
          code: 'not_a_project_member',
          message: 'Target user is not a member of this project',
        })
      }
      if (targetMembership.role === 'owner') {
        return reply
          .status(409)
          .send({ code: 'already_owner', message: 'User is already the project owner' })
      }

      // Resolve the *current* owner FOR UPDATE so the race guard works whether the caller is
      // the owner themselves or an org owner acting on their behalf.
      const [currentOwner] = await secureCtx.tx
        .select({ userId: projectMemberships.userId })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, params.projectId),
            eq(projectMemberships.role, 'owner')
          )
        )
        .for('update')
        .limit(1)
      if (!currentOwner) {
        return reply.status(409).send({
          code: 'ownership_already_changed',
          message: 'Project ownership changed concurrently — reload and retry',
        })
      }

      const demoted = await secureCtx.tx
        .update(projectMemberships)
        .set({ role: 'admin' })
        .where(
          and(
            eq(projectMemberships.projectId, params.projectId),
            eq(projectMemberships.userId, currentOwner.userId),
            eq(projectMemberships.role, 'owner')
          )
        )
        .returning({ userId: projectMemberships.userId })
      if (demoted.length === 0) {
        return reply.status(409).send({
          code: 'ownership_already_changed',
          message: 'Project ownership changed concurrently — reload and retry',
        })
      }

      await secureCtx.tx
        .update(projectMemberships)
        .set({ role: 'owner' })
        .where(
          and(
            eq(projectMemberships.projectId, params.projectId),
            eq(projectMemberships.userId, parsed.data.newOwnerId)
          )
        )

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_OWNERSHIP_TRANSFERRED,
        resourceId: params.projectId,
        payload: { previousOwnerId: currentOwner.userId, newOwnerId: parsed.data.newOwnerId },
        request: req,
      })

      return {
        data: {
          projectId: params.projectId,
          previousOwnerId: currentOwner.userId,
          newOwnerId: parsed.data.newOwnerId,
        },
      }
    },
  })
}
