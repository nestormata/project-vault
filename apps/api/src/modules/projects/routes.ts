import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { ActiveMachineUserKeysErrorSchema, AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { dedupeTags, tagDelta } from '../../lib/tags.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { projectMemberships, projects, users } from '@project-vault/db/schema'
import { buildPaginationMeta, parsePagination, paginationOffset } from '../../lib/pagination.js'
import {
  ActiveRotationsErrorSchema,
  ArchiveResponseSchema,
  CreateProjectBodySchema,
  ListProjectsQuerySchema,
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
import { getProjectMembershipRole, removeProjectMembership } from './member-management.js'
import {
  findBlockingRotationIds,
  PROJECT_ARCHIVED_ERROR,
  rejectIfProjectArchived,
} from './archive-guards.js'
import { activeMachineUserKeysQuery } from '../machine-users/archival-check.js'

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const

// Inline project-role lookup — see 4.1 D-notes / 4.4 AC-2 for why this isn't centralized as a
// cross-module resolver yet; 3rd cross-story occurrence as of 4.2, consider extracting if a 4th
// consumer appears. This module-local helper only dedupes the identical query across this file's
// three new handlers (AC-5/AC-6/AC-10); it is not the shared resolver D8 defers.
// Epic 4 retro P4-1: delegates to the same `getProjectMembershipRole` helper org/routes.ts uses,
// scoped to the caller, so the (projectId, userId, orgId) lookup lives in exactly one place.
// Exported (Story 6.3 ADR-6.3-07) so the status-page admin routes reuse this exact query shape
// instead of diverging on a second "who is this project's owner" answer.
export async function callerProjectRole(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<string | undefined> {
  return getProjectMembershipRole(secureCtx.tx, {
    orgId: secureCtx.auth.orgId,
    projectId,
    userId: secureCtx.auth.userId,
  })
}

// Shared member-management authorization: a project admin/owner OR an org admin/owner may view and
// mutate a project's member list (D1). Dedupes the identical check across the GET-members and
// DELETE-member handlers; each call site keeps its own 403 message.
async function callerCanManageMembers(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<boolean> {
  const callerRole = await callerProjectRole(secureCtx, projectId)
  const isProjectAdminOrOwner = callerRole === 'admin' || callerRole === 'owner'
  const isOrgAdminOrOwner = secureCtx.auth.orgRole === 'admin' || secureCtx.auth.orgRole === 'owner'
  return isProjectAdminOrOwner || isOrgAdminOrOwner
}

// 4.4 AC-2/AC-6/ADR-4.4-05: archive/unarchive is restricted to the project owner OR an org owner
// (org owners retain authority over every project in their org even without a membership row).
// Returns which path authorized the caller (or null if neither) so the audit row can record
// "acted as project owner" vs. "acted via org-owner override" (ADR-4.4-05 consequences).
async function callerArchiveAuthorization(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<'project_owner' | 'org_owner' | null> {
  const callerRole = await callerProjectRole(secureCtx, projectId)
  if (callerRole === 'owner') return 'project_owner'
  if (secureCtx.auth.orgRole === 'owner') return 'org_owner'
  return null
}

// 4.4 AC-12 "Audit gap (denied/blocked attempts)": SecureRoute's same-tx audit writer only fires
// on the success path, so 403/409 rejections on this high-impact, MFA-gated lifecycle action are
// never written to the audit log. Emit a structured application log line instead so security
// monitoring has a signal for repeated unauthorized/blocked attempts.
function logArchiveDenied(
  req: { log: { warn: (payload: Record<string, unknown>, msg?: string) => void } },
  input: { projectId: string; callerId: string; reason: string }
): void {
  req.log.warn(
    { event: 'project.archive_denied', ...input },
    'Project archive/unarchive request denied'
  )
}

type ArchiveTogglePreflight =
  | {
      ok: true
      params: { projectId: string }
      secureCtx: SecureRouteContext
      project: { id: string; archivedAt: Date | null }
      authorizedVia: 'project_owner' | 'org_owner'
    }
  | { ok: false }

/**
 * Shared preflight for POST /:projectId/archive and /:projectId/unarchive: validates params,
 * locks the project row FOR UPDATE (AC-4 concurrency note — closes the TOCTOU window between the
 * active-rotation guard and the archive commit), and enforces the project-owner-or-org-owner
 * check (AC-2/AC-6, ordering rationale: ownership MUST be checked before either route's
 * idempotency check, or a non-owner could distinguish archival state from a 403). Extracted so
 * the two routes' near-identical setup isn't duplicated verbatim.
 */
async function loadOwnedProjectForArchiveToggle(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  actionVerb: 'archive' | 'unarchive'
): Promise<ArchiveTogglePreflight> {
  const params = parseParams(ProjectParamsSchema, req, reply)
  if (!params) return { ok: false }
  const secureCtx = ctx as SecureRouteContext

  const [project] = await secureCtx.tx
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, params.projectId))
    .for('update')
    .limit(1)
  if (!project) {
    logArchiveDenied(req, {
      projectId: params.projectId,
      callerId: secureCtx.auth.userId,
      reason: 'project_not_found',
    })
    reply.status(404).send(PROJECT_NOT_FOUND)
    return { ok: false }
  }

  const authorizedVia = await callerArchiveAuthorization(secureCtx, params.projectId)
  if (!authorizedVia) {
    logArchiveDenied(req, {
      projectId: params.projectId,
      callerId: secureCtx.auth.userId,
      reason: 'insufficient_role',
    })
    reply.status(403).send({
      code: 'insufficient_role',
      message: `Only the project owner can ${actionVerb} a project`,
    })
    return { ok: false }
  }

  return { ok: true, params, secureCtx, project, authorizedVia }
}

type TransferTargetsResult =
  | { ok: true; targetMembership: { role: string }; currentOwner: { userId: string } }
  | { ok: false; status: number; body: Record<string, unknown> }

const OWNERSHIP_ALREADY_CHANGED = {
  code: 'ownership_already_changed',
  message: 'Project ownership changed concurrently — reload and retry',
} as const

// Extracted from the transfer-ownership handler purely to keep its cyclomatic complexity under
// the repo's eslint threshold once the 4.4 archived-project guard was added; behavior unchanged.
async function resolveTransferTargets(
  secureCtx: SecureRouteContext,
  projectId: string,
  newOwnerId: string
): Promise<TransferTargetsResult> {
  const [targetMembership] = await secureCtx.tx
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, newOwnerId),
        eq(projectMemberships.orgId, secureCtx.auth.orgId)
      )
    )
    .limit(1)
  if (!targetMembership) {
    return {
      ok: false,
      status: 404,
      body: {
        code: 'not_a_project_member',
        message: 'Target user is not a member of this project',
      },
    }
  }
  if (targetMembership.role === 'owner') {
    return {
      ok: false,
      status: 409,
      body: { code: 'already_owner', message: 'User is already the project owner' },
    }
  }

  // Resolve the *current* owner FOR UPDATE so the race guard works whether the caller is the
  // owner themselves or an org owner acting on their behalf.
  const [currentOwner] = await secureCtx.tx
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.role, 'owner')))
    .for('update')
    .limit(1)
  if (!currentOwner) {
    return { ok: false, status: 409, body: OWNERSHIP_ALREADY_CHANGED }
  }
  return { ok: true, targetMembership, currentOwner }
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
      response: { 200: ProjectListResponseSchema, 401: ApiErrorSchema, 422: ApiErrorSchema },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsedQuery = ListProjectsQuerySchema.safeParse(req.query)
      if (!parsedQuery.success) {
        return reply.status(422).send(validationError(parsedQuery.error, 'query'))
      }
      const { includeArchived, page, limit } = parsedQuery.data

      // Story 9.3 D8.2/AC-12: deliberately no deep-OFFSET cap (unlike credentials's
      // MAX_CREDENTIAL_LIST_OFFSET) — AC-12's own worked example requires `page=999&limit=20`
      // on a 3-project org to return a well-formed empty 200, not a 422 PAGE_OUT_OF_RANGE_ERROR.
      // A per-org project count large enough for deep-OFFSET cost to matter is a materially
      // different scale than credentials-per-project, so the two endpoints reasonably differ here.
      const pagination = parsePagination(page, limit)
      const offset = paginationOffset(pagination)

      const listWhere = includeArchived ? undefined : isNull(projects.archivedAt)

      const [{ total } = { total: 0 }] = await secureCtx.tx
        .select({ total: sql<number>`count(*)` })
        .from(projects)
        .where(listWhere)

      const rows = await secureCtx.tx
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
          role: projectMemberships.role,
          createdAt: projects.createdAt,
          archivedAt: projects.archivedAt,
        })
        .from(projects)
        .leftJoin(
          projectMemberships,
          and(
            eq(projectMemberships.projectId, projects.id),
            eq(projectMemberships.userId, secureCtx.auth.userId)
          )
        )
        .where(listWhere)
        .orderBy(desc(projects.createdAt))
        .limit(pagination.limit)
        .offset(offset)

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
          archivedAt: row.archivedAt?.toISOString() ?? null,
          isArchived: row.archivedAt !== null,
        }
      })

      return { data: { items, ...buildPaginationMeta(pagination, Number(total)) } }
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
      // 4.4 AC-5: reads (including the dashboard) remain fully available on archived projects —
      // only mutations are guarded. Do not filter on archivedAt here.
      const rows = await secureCtx.tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, params.projectId))
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
        410: ApiErrorSchema,
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

      // 4.4 AC-5: an archived project is read-only — reject metadata edits with 410 (distinct
      // from 404 "not found"/cross-org), never a silent 404.
      const [existing] = await secureCtx.tx
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .limit(1)
      if (!existing) return reply.status(404).send(PROJECT_NOT_FOUND)
      if (existing.archivedAt !== null) return reply.status(410).send(PROJECT_ARCHIVED_ERROR)

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
        410: ApiErrorSchema,
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
        .select({ id: projects.id, tags: projects.tags, archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .for('update')
        .limit(1)
      if (!current) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }
      // 4.4 AC-5: tagging is a mutation of an existing resource — reject with 410 if archived.
      if (current.archivedAt !== null) {
        return reply.status(410).send(PROJECT_ARCHIVED_ERROR)
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

      if (!(await callerCanManageMembers(secureCtx, params.projectId))) {
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

      const targetMembershipRole = await getProjectMembershipRole(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: params.userId,
      })
      if (!targetMembershipRole) {
        return reply
          .status(404)
          .send({ code: 'membership_not_found', message: 'User is not a member of this project' })
      }

      if (!(await callerCanManageMembers(secureCtx, params.projectId))) {
        return reply.status(403).send({
          code: 'insufficient_role',
          message: 'Only project admins/owners or org admins/owners can remove project members',
        })
      }

      // D5 item 1: never remove the last owner of a project (self-removal is no exception).
      if (targetMembershipRole === 'owner') {
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
        payload: { projectId: params.projectId, removedRole: targetMembershipRole },
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
        410: ApiErrorSchema,
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

      // 4.4 AC-5: ownership transfer mutates project membership — reject on an archived project.
      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      // Self-transfer no-op rejection (request-shape problem — 422).
      if (parsed.data.newOwnerId === secureCtx.auth.userId) {
        return reply
          .status(422)
          .send({ code: 'invalid_new_owner', message: 'Cannot transfer ownership to yourself' })
      }

      // AC-E4c: target must already be an accepted member of the project.
      const targets = await resolveTransferTargets(
        secureCtx,
        params.projectId,
        parsed.data.newOwnerId
      )
      if (!targets.ok) return reply.status(targets.status).send(targets.body)
      const { currentOwner } = targets

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
        return reply.status(409).send(OWNERSHIP_ALREADY_CHANGED)
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

  // AC-2: archive a project (owner only). Non-destructive — sets archived_at, deletes nothing.
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/archive',
    schema: {
      response: {
        200: ArchiveResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([
          ApiErrorSchema,
          ActiveRotationsErrorSchema,
          ActiveMachineUserKeysErrorSchema,
        ]),
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin', // org-level floor; in-handler project-owner check is stricter.
      requireMfa: true,
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/archive',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const preflight = await loadOwnedProjectForArchiveToggle(ctx, req, reply, 'archive')
      if (!preflight.ok) return reply
      const { params, secureCtx, project, authorizedVia } = preflight

      // Idempotency check runs after ownership (AC-2 ordering rationale): a non-owner must
      // always get 403 regardless of archival state, or they could distinguish "already
      // archived" (409) from "not owner" (403) for an arbitrary in-org project id.
      if (project.archivedAt !== null) {
        logArchiveDenied(req, {
          projectId: params.projectId,
          callerId: secureCtx.auth.userId,
          reason: 'already_archived',
        })
        return reply
          .status(409)
          .send({ code: 'already_archived', message: 'Project is already archived' })
      }

      const blockingRotationIds = await findBlockingRotationIds(secureCtx.tx, params.projectId)
      if (blockingRotationIds.length > 0) {
        logArchiveDenied(req, {
          projectId: params.projectId,
          callerId: secureCtx.auth.userId,
          reason: 'active_rotations',
        })
        return reply
          .status(409)
          .send({ error: 'active_rotations', rotationIds: blockingRotationIds })
      }

      // Story 7.2 D12: activeMachineUserKeysQuery() is the same query hasActiveMachineUserKeys()
      // (archive-guards.ts) delegates to — queried directly here (not via the boolean helper)
      // since the block response needs the actual machineUserIds, matching AC-23's exact shape.
      const activeMachineUserKeys = await activeMachineUserKeysQuery(secureCtx.tx, params.projectId)
      if (activeMachineUserKeys.length > 0) {
        logArchiveDenied(req, {
          projectId: params.projectId,
          callerId: secureCtx.auth.userId,
          reason: 'active_machine_user_keys',
        })
        return reply.status(409).send({
          error: 'active_machine_user_keys' as const,
          machineUserIds: activeMachineUserKeys.map((row) => row.machineUserId),
        })
      }

      const [archived] = await secureCtx.tx
        .update(projects)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
        .returning({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          archivedAt: projects.archivedAt,
        })

      if (!archived) {
        // 0 rows means a racing request archived it first between our load and this UPDATE.
        return reply
          .status(409)
          .send({ code: 'already_archived', message: 'Project is already archived' })
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_ARCHIVED,
        resourceId: archived.id,
        // ADR-4.4-05: record which path authorized this action so a security review can
        // distinguish "acted as project owner" from "acted via org-owner override".
        payload: { authorizedVia },
        request: req,
      })

      return {
        data: {
          id: archived.id,
          name: archived.name,
          slug: archived.slug,
          archivedAt: archived.archivedAt?.toISOString() ?? null,
          isArchived: true,
        },
      }
    },
  })

  // AC-6: unarchive (restore) a project (owner only).
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/unarchive',
    schema: {
      response: {
        200: ArchiveResponseSchema,
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
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/projects/:projectId/unarchive',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const preflight = await loadOwnedProjectForArchiveToggle(ctx, req, reply, 'unarchive')
      if (!preflight.ok) return reply
      const { params, secureCtx, project, authorizedVia } = preflight

      if (project.archivedAt === null) {
        logArchiveDenied(req, {
          projectId: params.projectId,
          callerId: secureCtx.auth.userId,
          reason: 'not_archived',
        })
        return reply.status(409).send({ code: 'not_archived', message: 'Project is not archived' })
      }

      const [restored] = await secureCtx.tx
        .update(projects)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(and(eq(projects.id, params.projectId), isNotNull(projects.archivedAt)))
        .returning({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          archivedAt: projects.archivedAt,
        })

      if (!restored) {
        return reply.status(409).send({ code: 'not_archived', message: 'Project is not archived' })
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'project',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: AuditEvent.PROJECT_UNARCHIVED,
        resourceId: restored.id,
        // ADR-4.4-05: record which path authorized this action so a security review can
        // distinguish "acted as project owner" from "acted via org-owner override".
        payload: { authorizedVia },
        request: req,
      })

      return {
        data: {
          id: restored.id,
          name: restored.name,
          slug: restored.slug,
          archivedAt: null,
          isArchived: false,
        },
      }
    },
  })
}
