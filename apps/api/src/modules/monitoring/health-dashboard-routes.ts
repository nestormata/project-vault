import { HealthDashboardResponseSchema } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { getHealthDashboardData } from './health-dashboard-service.js'
import { LIST_RATE_LIMIT } from './routes.js'

/**
 * Story 6.3 AC 1/2/4-6: single GET route mirroring `dashboardRoutes` exactly — a health-status
 * read is not a sensitive action (`writeAuditEvent: false`), any org role may view it
 * (`minimumRole: 'viewer'`), and it reuses the same LIST_RATE_LIMIT constant already defined for
 * this module's other list reads (AC 6, do not redefine a diverging value).
 */
export async function healthDashboardRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '',
    schema: {
      response: { 200: HealthDashboardResponseSchema, 401: ApiErrorSchema },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/health-dashboard' },
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      return { data: await getHealthDashboardData(secureCtx.tx) }
    },
  })
}
