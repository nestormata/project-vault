import { z } from 'zod/v4'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { countUnreadInboxEntries } from '../../workers/notification-inbox.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'

const usersMeResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),
    notifications: z.object({ unreadCount: z.number().int().min(0) }),
  }),
})

export async function usersRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/me',
    schema: {
      response: {
        200: usersMeResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'],
      writeAuditEvent: false,
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const unreadCount = await countUnreadInboxEntries(secureCtx.auth.orgId, secureCtx.auth.userId)
      return {
        data: {
          userId: secureCtx.auth.userId,
          orgId: secureCtx.auth.orgId,
          orgRole: secureCtx.auth.orgRole,
          notifications: { unreadCount },
        },
      }
    },
  })
}
