import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { projectMemberships, projects } from '@project-vault/db/schema'
import type { Tx } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import {
  SameTransactionAuditWriteError,
  secureRoute,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import {
  CreateProjectBodySchema,
  PatchProjectBodySchema,
  PatchProjectResponseSchema,
  ProjectCreateResponseSchema,
  ProjectDashboardResponseSchema,
  ProjectListResponseSchema,
  ProjectParamsSchema,
  type CreateProjectBody,
  type PatchProjectBody,
} from './schema.js'

type ProjectAuditInput = {
  orgId: string
  actorUserId: string
  eventType: 'project.created' | 'project.updated'
  resourceId: string
  payload: Record<string, unknown>
  request: FastifyRequest
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

function parseBody<T>(
  schema: {
    safeParse: (
      body: unknown
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }
  },
  req: FastifyRequest,
  reply: FastifyReply
): { success: true; data: T } | { success: false } {
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'body'))
    return { success: false }
  }
  return { success: true, data: parsed.data }
}

function parseParams(req: FastifyRequest, reply: FastifyReply) {
  const parsed = ProjectParamsSchema.safeParse(req.params)
  if (!parsed.success) {
    reply.status(422).send(validationError(parsed.error, 'params'))
    return null
  }
  return parsed.data
}

async function writeProjectAudit(tx: Tx, input: ProjectAuditInput): Promise<void> {
  try {
    const actorTokenId = await firstActorTokenIdForUser(tx, input.actorUserId)
    await writeHumanAuditEntry(tx, {
      orgId: input.orgId,
      actorTokenId,
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: 'project',
      payload: input.payload,
      meta: {
        ipAddress: input.request.ip,
        userAgent:
          typeof input.request.headers['user-agent'] === 'string'
            ? input.request.headers['user-agent']
            : null,
      },
    })
  } catch (error) {
    throw new SameTransactionAuditWriteError(error instanceof Error ? error.message : String(error))
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
      await writeProjectAudit(secureCtx.tx, {
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
      const params = parseParams(req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      const rows = await secureCtx.tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
        .limit(1)
      if (!rows[0]) {
        return reply.status(404).send({ code: 'project_not_found', message: 'Project not found' })
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
      const params = parseParams(req, reply)
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
        return reply.status(404).send({ code: 'project_not_found', message: 'Project not found' })
      }

      await writeProjectAudit(secureCtx.tx, {
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
}
