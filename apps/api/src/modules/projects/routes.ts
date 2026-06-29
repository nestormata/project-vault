import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { projectMemberships, projects } from '@project-vault/db/schema'
import {
  CreateProjectBodySchema,
  PatchProjectBodySchema,
  PatchProjectResponseSchema,
  ProjectCreateResponseSchema,
  ProjectDashboardResponseSchema,
  ProjectListResponseSchema,
  ProjectParamsSchema,
  ProjectTagUpdateResponseSchema,
  TagArrayBodySchema,
  type CreateProjectBody,
  type PatchProjectBody,
} from './schema.js'

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const

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

function dedupeTags(tags: string[]): string[] {
  return tags.filter((tag, index) => tags.indexOf(tag) === index)
}

function tagDelta(oldTags: string[], newTags: string[]) {
  return {
    added: newTags.filter((tag) => !oldTags.includes(tag)),
    removed: oldTags.filter((tag) => !newTags.includes(tag)),
  }
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

function emptyDashboard() {
  const credentialStats = { active: 0, expiringSoon: 0, expired: 0 }
  const monitoredServiceHealth = { healthy: 0, degraded: 0, down: 0 }
  const credentialTotal =
    credentialStats.active + credentialStats.expiringSoon + credentialStats.expired
  const serviceTotal =
    monitoredServiceHealth.healthy + monitoredServiceHealth.degraded + monitoredServiceHealth.down
  const isEmpty = credentialTotal === 0 && serviceTotal === 0
  return {
    credentialStats,
    upcomingRotations: [],
    monitoredServiceHealth,
    recentAccessEvents: [],
    unresolvedAlertCount: 0,
    isEmpty,
    suggestedActions: isEmpty ? ['add_credential', 'add_service', 'import_credentials'] : [],
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

      const items = rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        role: (row.role ?? secureCtx.auth.orgRole) as 'owner' | 'admin' | 'member' | 'viewer',
        credentialCount: 0,
        expiringCount: 0,
        alertCount: 0,
        createdAt: row.createdAt.toISOString(),
      }))

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
      return { data: emptyDashboard() }
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
}
