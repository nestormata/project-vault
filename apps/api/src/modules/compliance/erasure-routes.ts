import { z } from 'zod/v4'
import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import {
  buildErasureReport,
  createErasureRequest,
  executeErasure,
  findLatestAuditEventId,
} from './erasure-service.js'
import {
  AlreadyCompletedErrorSchema,
  CreateErasureRequestBodySchema,
  CreateErasureRequestResponseSchema,
  ErasureAlreadyPendingErrorSchema,
  ErasureExecuteParamsSchema,
  ErasureExecutionInProgressErrorSchema,
  ErasureNotYetCompletedErrorSchema,
  ErasureReportResponseSchema,
  ErasureRequestParamsSchema,
  ExecuteErasureBodySchema,
  ExecuteErasureResponseSchema,
  UserAlreadyErasedErrorSchema,
  UserHasOtherOrgMembershipsErrorSchema,
} from './schema.js'

const USER_NOT_FOUND = { code: 'user_not_found', message: 'User not found' } as const
const ERASURE_REQUEST_NOT_FOUND = {
  code: 'erasure_request_not_found',
  message: 'Erasure request not found',
} as const

/** Scoped to prefix '/api/v1/org' — governed GDPR/CCPA right-to-erasure workflow (Story 8.4). */
export async function erasureRoutes(fastify: FastifyApp): Promise<void> {
  // AC-1/2/3/4, D7: admin+owner may create an erasure request and review the PII inventory
  // before ever calling execute.
  secureRoute(fastify, {
    method: 'POST',
    url: '/users/:userId/erasure-request',
    schema: {
      response: {
        201: CreateErasureRequestResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([
          ErasureAlreadyPendingErrorSchema,
          ErasureExecutionInProgressErrorSchema,
          ApiErrorSchema,
        ]),
        410: z.union([UserAlreadyErasedErrorSchema, ApiErrorSchema]),
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/org/users/:userId/erasure-request',
      },
      writeAuditEvent: false, // erasure-service writes user.erasure_requested inline.
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const params = parseParams(ErasureRequestParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(CreateErasureRequestBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const outcome = await createErasureRequest(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        userId: params.userId,
        requestedBy: parsed.data.requestedBy,
        reason: parsed.data.reason,
      })

      switch (outcome.code) {
        case 'user_not_found':
          return reply.status(404).send(USER_NOT_FOUND)
        case 'already_pending':
          return reply.status(409).send({
            code: 'erasure_request_already_pending',
            message: 'An erasure request is already pending for this user',
            requestId: outcome.requestId,
            piiInventory: outcome.inventory,
          })
        case 'execution_in_progress':
          return reply.status(409).send({
            code: 'erasure_execution_in_progress',
            message: 'Erasure execution is already in progress for this user',
            requestId: outcome.requestId,
          })
        case 'already_completed':
          return reply.status(410).send({
            code: 'user_already_erased',
            message: 'This user has already been erased',
            requestId: outcome.requestId,
            completedAt: outcome.completedAt.toISOString(),
          })
        case 'conflict':
          return reply.status(409).send({
            code: 'erasure_request_conflict',
            message: 'An erasure request for this user already exists in another organization',
          })
        case 'created':
          // D10: written directly here (not from erasure-service.ts) so route-audit.test.ts's
          // static "audit-write call site lives in the route file" check can verify it.
          await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
            orgId: secureCtx.auth.orgId,
            actorUserId: secureCtx.auth.userId,
            eventType: AuditEvent.USER_ERASURE_REQUESTED,
            resourceId: params.userId,
            resourceType: 'user',
            payload: { dataErasureRequestId: outcome.requestId, reason: parsed.data.reason },
            request: req,
          })
          reply.status(201)
          return {
            data: {
              requestId: outcome.requestId,
              status: 'pending' as const,
              piiInventory: outcome.inventory,
            },
          }
      }
    },
  })

  // AC-5 through AC-13, D2/D7/D9/D11: irreversible, owner-only execution.
  secureRoute(fastify, {
    method: 'POST',
    url: '/users/:userId/erasure-request/:requestId/execute',
    schema: {
      response: {
        200: ExecuteErasureResponseSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([
          UserHasOtherOrgMembershipsErrorSchema,
          AlreadyCompletedErrorSchema,
          ApiErrorSchema,
        ]),
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'owner',
      requireMfa: true,
      rateLimit: {
        max: 5,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/org/users/:userId/erasure-request/:requestId/execute',
      },
      writeAuditEvent: false, // erasure-service writes user.erasure_executed inline.
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const params = parseParams(ErasureExecuteParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(ExecuteErasureBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      // AC-6: schema already guarantees `confirm` is strictly boolean with no extra keys —
      // this is the business-logic gate on top of that (confirm: false is schema-valid but
      // must still be rejected before any mutation).
      if (!parsed.data.confirm) {
        return reply.status(400).send({
          code: 'confirmation_required',
          message: 'Erasure is irreversible; confirm: true is required',
        })
      }

      const outcome = await executeErasure(secureCtx.tx, {
        requestId: params.requestId,
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
      })

      switch (outcome.code) {
        case 'not_found':
          return reply.status(404).send(ERASURE_REQUEST_NOT_FOUND)
        case 'user_has_other_org_memberships':
          return reply.status(409).send({
            code: 'user_has_other_org_memberships',
            message: 'This user belongs to other organizations; erasure cannot proceed',
            otherOrgCount: outcome.otherOrgCount,
            remediation:
              "Contact support to coordinate removal of this user's membership in the other org(s) before erasure can proceed.",
          })
        case 'already_completed':
          return reply.status(409).send({
            code: 'already_completed',
            message: 'This erasure request has already been completed',
            completedAt: outcome.completedAt.toISOString(),
          })
        case 'erasure_already_in_progress':
          return reply.status(409).send({
            code: 'erasure_already_in_progress',
            message: 'Another erasure execution for this request is already in progress',
          })
        case 'completed': {
          // Step 9 (D10): written directly here (not from erasure-service.ts) so
          // route-audit.test.ts's static "audit-write call site lives in the route file" check
          // can verify it — same reasoning as the create-request route above. Actor is the
          // executing owner, resource is the erased user; payload carries no PII.
          await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
            orgId: secureCtx.auth.orgId,
            actorUserId: secureCtx.auth.userId,
            eventType: AuditEvent.USER_ERASURE_EXECUTED,
            resourceId: outcome.userId,
            resourceType: 'user',
            payload: {
              dataErasureRequestId: params.requestId,
              tablesErased: outcome.tablesErased,
              revokedSessionCount: outcome.revokedSessionCount,
            },
            request: req,
          })
          const auditEventId = await findLatestAuditEventId(secureCtx.tx, {
            orgId: secureCtx.auth.orgId,
            eventType: AuditEvent.USER_ERASURE_EXECUTED,
            resourceId: outcome.userId,
          })
          return {
            data: {
              requestId: params.requestId,
              status: 'completed' as const,
              completedAt: outcome.completedAt.toISOString(),
              revokedSessionCount: outcome.revokedSessionCount,
              auditEventId,
            },
          }
        }
      }
    },
  })

  // AC-14/15/16, D7: read-only compliance artifact, admin+owner.
  secureRoute(fastify, {
    method: 'GET',
    url: '/users/:userId/erasure-request/:requestId/report',
    schema: {
      response: {
        200: ErasureReportResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: z.union([ErasureNotYetCompletedErrorSchema, ApiErrorSchema]),
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/org/users/:userId/erasure-request/:requestId/report',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const params = parseParams(ErasureExecuteParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const outcome = await buildErasureReport(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        requestId: params.requestId,
      })

      switch (outcome.code) {
        case 'not_found':
          return reply.status(404).send(ERASURE_REQUEST_NOT_FOUND)
        case 'not_yet_completed':
          return reply.status(409).send({
            code: 'erasure_not_yet_completed',
            message: 'Erasure has not yet been executed for this request',
            status: outcome.status,
          })
        case 'completed':
          return { data: outcome.report }
      }
    },
  })
}
