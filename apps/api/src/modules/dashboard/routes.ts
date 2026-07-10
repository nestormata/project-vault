import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { getOrgDashboardData } from '../projects/dashboard-stats.js'
import { OrgDashboardResponseSchema } from './schema.js'

export async function dashboardRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '',
    schema: {
      response: { 200: OrgDashboardResponseSchema, 401: ApiErrorSchema },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      return {
        data: await getOrgDashboardData(secureCtx.tx, {
          userId: secureCtx.auth.userId,
          orgRole: secureCtx.auth.orgRole,
        }),
      }
    },
  })
}
