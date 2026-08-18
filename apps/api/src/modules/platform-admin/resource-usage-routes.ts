// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { resolveResourceUsage } from './service.js'
import { ResourceUsageResponseSchema } from './schema.js'
import { PLATFORM_ADMIN_ERROR_RESPONSES } from './route-common.js'

/**
 * Story 9.2 D2/AC-12 through AC-14: `GET /admin/resource-usage` — cross-org resource-usage
 * visibility against operator-configured instance limits. `requireOrgScope: false` +
 * `requirePlatformOperator: true` + `requireMfa: true` — never `allowedRoles`/`requireOrgRole`.
 */
export async function resourceUsageRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/resource-usage',
    schema: {
      tags: ['Platform Admin'],
      response: {
        200: ResourceUsageResponseSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    // requirePlatformOperator: true guarantees `auth` is populated even though requireOrgScope
    // is false (the union also covers PublicRouteContext for routes with no auth at all).
    handler: async (ctx) => resolveResourceUsage((ctx as SecureRouteContext).auth.orgId),
  })
}
