import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { firstActorTokenIdForUser } from '../audit/actor-token.js'
import { dismissSecurityAlertByToken } from './security-alerts.js'
import {
  DismissAlertBodySchema,
  DismissAlertParamsSchema,
  DismissAlertResponseSchema,
} from './security-alert-actions-schema.js'

const ALERT_NOT_FOUND = { code: 'alert_not_found', message: 'Security alert not found' } as const
const ALERT_ALREADY_DISMISSED = {
  code: 'alert_already_dismissed',
  message: 'This alert has already been dismissed',
} as const

// Story 7.2 D9/AC-22 — generic dismiss endpoint, not machine-key-specific at the route level so
// any future security_alerts alertType can reuse it without a new endpoint.
export async function securityAlertActionsRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:alertId/dismiss',
    schema: {
      body: DismissAlertBodySchema,
      response: {
        200: DismissAlertResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: true,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/security-alerts/:alertId/dismiss',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(DismissAlertParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(DismissAlertBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const actorTokenId = await firstActorTokenIdForUser(secureCtx.tx, secureCtx.auth.userId)
      const result = await dismissSecurityAlertByToken(secureCtx.tx, {
        alertId: params.alertId,
        actorTokenId,
        reason: parsed.data.reason,
      })

      if (result.status === 'not_found') return reply.status(404).send(ALERT_NOT_FOUND)
      if (result.status === 'already_dismissed') {
        return reply.status(409).send(ALERT_ALREADY_DISMISSED)
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'security_alert',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'security_alert.dismissed',
        resourceId: result.id,
        payload: { reason: parsed.data.reason },
        request: req,
      })

      return { data: { id: result.id, status: 'dismissed' as const } }
    },
  })
}
