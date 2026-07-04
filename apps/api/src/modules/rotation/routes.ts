import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import { buildPaginationMeta, paginationOffset, parsePagination } from '../../lib/pagination.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import {
  InitiateRotationBodySchema,
  InitiateRotationResponseSchema,
  ListRotationsQuerySchema,
  RotationConflictResponseSchema,
  RotationCredentialParamsSchema,
  RotationDetailResponseSchema,
  RotationHistoryResponseSchema,
  RotationParamsSchema,
  type InitiateRotationBody,
} from './schema.js'
import {
  RotationConflictError,
  findCredentialInProject,
  getRotationDetail,
  initiateRotation,
  listRotationHistory,
  serializeRotationDetail,
} from './service.js'
import { rotationInitiationsTotal } from './metrics.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const
const ROTATION_NOT_FOUND = { code: 'rotation_not_found', message: 'Rotation not found' } as const

const INITIATE_ROTATION_RATE_LIMIT = {
  max: 30,
  timeWindowMs: 60_000,
  key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations',
} as const

export async function rotationRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/rotations',
    schema: {
      response: {
        201: InitiateRotationResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: RotationConflictResponseSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      // Rotation initiation writes a new live credential value and is one of the most
      // security-sensitive write paths in the system — same MFA-enrollment posture as
      // project archive/unarchive/transfer-ownership (see AC-7's required MFA test).
      requireMfa: true,
      rateLimit: INITIATE_ROTATION_RATE_LIMIT,
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationCredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<InitiateRotationBody>(InitiateRotationBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      let result
      try {
        result = await initiateRotation(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          credentialId: params.credentialId,
          userId: secureCtx.auth.userId,
          body: parsed.data,
        })
      } catch (error) {
        if (error instanceof RotationConflictError) {
          rotationInitiationsTotal.inc({ outcome: 'conflict' })
          req.log.info(
            {
              eventType: OperationalEvent.ROTATION_INITIATE_CONFLICT,
              orgId: secureCtx.auth.orgId,
              credentialId: params.credentialId,
            },
            'Rotation initiation rejected — a rotation is already in progress'
          )
          return reply.status(409).send({
            code: 'rotation_in_progress',
            message: 'A rotation is already in progress for this credential.',
            rotationId: error.rotationId,
          })
        }
        throw error
      }

      if (result.status === 'credential_not_found') {
        return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      }

      try {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: AuditEvent.ROTATION_INITIATED,
          resourceId: result.rotation.id,
          resourceType: 'rotation',
          payload: {
            credentialId: params.credentialId,
            projectId: params.projectId,
            checklistItemCount: result.checklistItems.length,
          },
          request: req,
        })
      } catch (error) {
        rotationInitiationsTotal.inc({ outcome: 'audit_failed' })
        req.log.error(
          {
            eventType: OperationalEvent.ROTATION_INITIATE_AUDIT_FAILED,
            orgId: secureCtx.auth.orgId,
            credentialId: params.credentialId,
          },
          'Rotation initiation audit write failed — transaction will roll back'
        )
        throw error
      }

      rotationInitiationsTotal.inc({ outcome: 'success' })
      if (result.sameValueAsPrevious) {
        req.log.warn(
          {
            eventType: OperationalEvent.ROTATION_INITIATE_SAME_VALUE_WARNING,
            credentialId: params.credentialId,
            rotationId: result.rotation.id,
          },
          'Rotation initiated with a newValue identical to the previous version'
        )
      }
      req.log.info(
        {
          eventType: OperationalEvent.ROTATION_INITIATE_SUCCESS,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          rotationId: result.rotation.id,
          itemCount: result.checklistItems.length,
        },
        'Rotation initiated'
      )

      reply.status(201)
      return {
        data: serializeRotationDetail(result.rotation, result.checklistItems, {
          sameValueAsPrevious: result.sameValueAsPrevious,
        }),
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/rotations/:rotationId',
    schema: {
      response: {
        200: RotationDetailResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const credentialExists = await findCredentialInProject(secureCtx.tx, params)
      if (!credentialExists) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      const detail = await getRotationDetail(secureCtx.tx, params)
      if (!detail) return reply.status(404).send(ROTATION_NOT_FOUND)

      return { data: detail }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/credentials/:credentialId/rotations',
    schema: {
      response: {
        200: RotationHistoryResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: {
        max: 120,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/projects/:projectId/credentials/:credentialId/rotations',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(RotationCredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsedQuery = ListRotationsQuerySchema.safeParse(req.query)
      if (!parsedQuery.success) {
        return reply.status(422).send(validationError(parsedQuery.error, 'query'))
      }
      const secureCtx = ctx as SecureRouteContext

      const credentialExists = await findCredentialInProject(secureCtx.tx, params)
      if (!credentialExists) return reply.status(404).send(CREDENTIAL_NOT_FOUND)

      const pagination = parsePagination(parsedQuery.data.page, parsedQuery.data.limit)
      const offset = paginationOffset(pagination)
      const { items, total } = await listRotationHistory(secureCtx.tx, {
        ...params,
        query: parsedQuery.data,
        limit: pagination.limit,
        offset,
      })
      const meta = buildPaginationMeta(pagination, total)
      return {
        data: {
          items,
          page: meta.page,
          limit: meta.limit,
          total: meta.total,
          hasMore: meta.hasNext,
        },
      }
    },
  })
}
