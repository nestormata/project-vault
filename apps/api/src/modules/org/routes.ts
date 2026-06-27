import { and, eq } from 'drizzle-orm'
import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyRequest } from 'fastify/types/request.js'
import { orgMemberships } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { validationError } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { revokeAllUserSessionsInOrg } from '../auth/session-revoke.js'
import { listSecurityAlerts } from './security-alerts.js'
import { OrgUserParamsSchema, SecurityAlertsQuerySchema } from './schema.js'

export async function orgRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/security-alerts',
    security: {
      allowedRoles: ['owner', 'admin'],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = SecurityAlertsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
      return {
        data: await listSecurityAlerts(secureCtx.auth.orgId, parsed.data, secureCtx.tx),
      }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/users/:userId/sessions',
    security: {
      allowedRoles: ['admin', 'owner'],
      requireMfa: true,
      rateLimit: { max: 20, key: 'DELETE /org/users/:userId/sessions' },
      writeAuditEvent: false, // Session service writes the specific audit row through secureCtx.tx.
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = OrgUserParamsSchema.safeParse(req.params)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'params'))

      const targetMembership = await secureCtx.tx
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(
          and(
            eq(orgMemberships.userId, parsed.data.userId),
            eq(orgMemberships.orgId, secureCtx.auth.orgId),
            eq(orgMemberships.status, 'active')
          )
        )
        .limit(1)
      if (!targetMembership[0]) {
        return reply.status(404).send({ code: 'user_not_found', message: 'User not found' })
      }

      const result = await revokeAllUserSessionsInOrg({
        userId: parsed.data.userId,
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        reason: 'admin_action',
        tx: secureCtx.tx,
      })

      return { data: { ...result, userId: parsed.data.userId } }
    },
  })
}
