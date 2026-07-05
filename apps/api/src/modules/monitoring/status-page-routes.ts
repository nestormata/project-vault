import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  StatusPageConfigResponseSchema,
  StatusPageServicesResponseSchema,
  StatusPageTokenResponseSchema,
} from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { rejectIfProjectArchived } from '../projects/archive-guards.js'
import { findProjectInOrg } from '../credentials/service.js'
import { callerProjectRole } from '../projects/routes.js'
import { LIST_RATE_LIMIT, WRITE_RATE_LIMIT, writeMonitoringAuditOrFailClosed } from './routes.js'
import {
  StatusPageProjectParamsSchema,
  UpdateStatusPageBodySchema,
  type StatusPageProjectParams,
} from './schema.js'
import {
  disableStatusPage,
  enableStatusPage,
  getStatusPageConfig,
  InvalidServiceReferenceError,
  regenerateStatusPageToken,
  StatusPageAlreadyEnabledError,
  StatusPageNotFoundError,
  updateStatusPageServices,
} from './status-page-service.js'

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const INSUFFICIENT_ROLE = {
  code: 'insufficient_role',
  message: 'Only the project owner or an org owner can manage the public status page',
} as const
const STATUS_PAGE_URL = '/:projectId/status-page'

const STATUS_PAGE_NOT_FOUND = {
  code: 'status_page_not_found',
  message: 'No status page exists for this project',
} as const

/** ADR-6.3-07: mirrors callerArchiveAuthorization exactly — project owner OR org owner. */
async function isProjectOwnerOrOrgOwner(
  secureCtx: SecureRouteContext,
  projectId: string
): Promise<boolean> {
  const callerRole = await callerProjectRole(secureCtx, projectId)
  return callerRole === 'owner' || secureCtx.auth.orgRole === 'owner'
}

type ProjectPreflight =
  { ok: true; params: StatusPageProjectParams; secureCtx: SecureRouteContext } | { ok: false }

/**
 * Shared preflight for every status-page route: parse params, reject an archived project (410,
 * no-op for a nonexistent project), 404 if the project isn't in the caller's org, then 403 if the
 * caller is neither the project owner nor an org owner (ADR-6.3-07). Mirrors the established
 * archived-then-not-found-then-ownership ordering already used by the archival routes.
 */
async function preflightOwnedProject(
  ctx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<ProjectPreflight> {
  const params = parseParams(StatusPageProjectParamsSchema, req, reply)
  if (!params) return { ok: false }

  if (await rejectIfProjectArchived(ctx.tx, params.projectId, reply)) return { ok: false }
  if (!(await findProjectInOrg(ctx.tx, params.projectId))) {
    reply.status(404).send(PROJECT_NOT_FOUND)
    return { ok: false }
  }
  if (!(await isProjectOwnerOrOrgOwner(ctx, params.projectId))) {
    reply.status(403).send(INSUFFICIENT_ROLE)
    return { ok: false }
  }
  return { ok: true, params, secureCtx: ctx }
}

export async function statusPageRoutes(fastify: FastifyApp): Promise<void> {
  // --- GET /:projectId/status-page (AC 21) ---
  secureRoute(fastify, {
    method: 'GET',
    url: STATUS_PAGE_URL,
    schema: {
      response: {
        200: StatusPageConfigResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/projects/:projectId/status-page' },
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const preflight = await preflightOwnedProject(secureCtx, req, reply)
      if (!preflight.ok) return reply
      return { data: await getStatusPageConfig(secureCtx.tx, preflight.params.projectId) }
    },
  })

  // --- POST /:projectId/status-page (AC 8, 9, 10, 10a) ---
  secureRoute(fastify, {
    method: 'POST',
    url: STATUS_PAGE_URL,
    schema: {
      response: {
        201: StatusPageTokenResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'POST /api/v1/projects/:projectId/status-page' },
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const preflight = await preflightOwnedProject(secureCtx, req, reply)
      if (!preflight.ok) return reply
      const { projectId } = preflight.params

      let enabled: Awaited<ReturnType<typeof enableStatusPage>>
      try {
        enabled = await enableStatusPage(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId,
          userId: secureCtx.auth.userId,
        })
      } catch (error) {
        if (error instanceof StatusPageAlreadyEnabledError) {
          reply.status(409).send({ code: error.code, message: error.message })
          return reply
        }
        throw error
      }

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'status_page',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'status_page.enabled',
        resourceId: enabled.id,
        payload: { projectId },
        request: req,
      })

      reply.status(201)
      return { data: { token: enabled.token, createdAt: enabled.createdAt } }
    },
  })

  // --- POST /:projectId/status-page/regenerate (AC 11) ---
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/status-page/regenerate',
    schema: {
      response: {
        200: StatusPageTokenResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'POST /api/v1/projects/:projectId/status-page/regenerate',
      },
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const preflight = await preflightOwnedProject(secureCtx, req, reply)
      if (!preflight.ok) return reply
      const { projectId } = preflight.params

      let regenerated: Awaited<ReturnType<typeof regenerateStatusPageToken>>
      try {
        regenerated = await regenerateStatusPageToken(secureCtx.tx, projectId)
      } catch (error) {
        if (error instanceof StatusPageNotFoundError) {
          reply.status(404).send({ code: error.code, message: error.message })
          return reply
        }
        throw error
      }

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'status_page',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'status_page.token_regenerated',
        resourceId: regenerated.id,
        payload: { projectId },
        request: req,
      })

      return { data: { token: regenerated.token, updatedAt: regenerated.updatedAt } }
    },
  })

  // --- PUT /:projectId/status-page (AC 15) ---
  secureRoute(fastify, {
    method: 'PUT',
    url: STATUS_PAGE_URL,
    schema: {
      response: {
        200: StatusPageServicesResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'PUT /api/v1/projects/:projectId/status-page' },
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const preflight = await preflightOwnedProject(secureCtx, req, reply)
      if (!preflight.ok) return reply
      const { projectId } = preflight.params

      const body = parseBody(UpdateStatusPageBodySchema, req, reply)
      if (!body.success) return reply

      let result: Awaited<ReturnType<typeof updateStatusPageServices>>
      try {
        result = await updateStatusPageServices(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId,
          body: body.data,
        })
      } catch (error) {
        if (error instanceof StatusPageNotFoundError) {
          reply.status(404).send({ code: error.code, message: error.message })
          return reply
        }
        if (error instanceof InvalidServiceReferenceError) {
          reply.status(422).send({ code: error.code, message: error.message })
          return reply
        }
        throw error
      }

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'status_page',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'status_page.updated',
        resourceId: result.statusPageId,
        payload: {
          projectId,
          previousServiceCount: result.previous.count,
          previousDisplayNames: result.previous.displayNames,
          newServiceCount: result.services.length,
          newDisplayNames: result.services.map((s) => s.displayName),
        },
        request: req,
      })

      return { data: { services: result.services } }
    },
  })

  // --- DELETE /:projectId/status-page (AC 16) ---
  secureRoute(fastify, {
    method: 'DELETE',
    url: STATUS_PAGE_URL,
    schema: {
      response: {
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'DELETE /api/v1/projects/:projectId/status-page' },
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const preflight = await preflightOwnedProject(secureCtx, req, reply)
      if (!preflight.ok) return reply
      const { projectId } = preflight.params

      const disabled = await disableStatusPage(secureCtx.tx, projectId)
      if (!disabled) return reply.status(404).send(STATUS_PAGE_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'status_page',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'status_page.disabled',
        resourceId: disabled.statusPageId,
        payload: {
          projectId,
          configuredServiceCount: disabled.snapshot.count,
          displayNames: disabled.snapshot.displayNames,
        },
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })
}
