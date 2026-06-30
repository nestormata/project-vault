import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { countUnreadInboxEntries } from '../../workers/notification-inbox.js'

export async function usersRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/me',
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
